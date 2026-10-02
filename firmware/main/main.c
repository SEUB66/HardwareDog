/*
 * HARDWARE DOG / FIRMWARE, ESP32-S3 reference device (LVL 60 to 80)
 *
 * Thin glue between the ESP-IDF drivers and the portable core
 * (components/hdp), which owns every HDP decision and is tested on a PC.
 *
 *   native USB (USB-Serial-JTAG)   HDP v1 to the host: Web Serial or dogd
 *   I2C0  GPIO 8 / 9               INA226, power of the target
 *   I2C1  GPIO 4 / 5               target I2C bus (scan on request or watch)
 *   UART1 GPIO 18 RX / 17 TX       target UART
 *   W5500 SPI2 (optional)          wired network port (net.c)
 *   Wi-Fi station (optional)       net.status, net.watch, probes (net.c)
 *   UART0                          ESP-IDF logs only, never HDP
 *
 * One task runs the core: no locking inside the core is needed. The network
 * tasks of net.c hand their results to this task, never to the core.
 */
#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/uart.h"
#include "driver/usb_serial_jtag.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hdp/hdp.h"
#include "net.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#define TARGET_UART UART_NUM_1
#define TARGET_I2C_HZ 100000
#define FW_VERSION "0.1.0"

static i2c_master_bus_handle_t power_bus;
static i2c_master_dev_handle_t ina226;
static i2c_master_bus_handle_t target_bus;
static QueueHandle_t uart_events;

/* ------------------------------------------------------------ HAL */

static uint32_t now_ms(void *ctx) {
    (void)ctx;
    return (uint32_t)(esp_timer_get_time() / 1000);
}

static void link_write(void *ctx, const char *data, size_t len) {
    (void)ctx;
    /* No host reading: the line is dropped after 20 ms instead of blocking
       the measurements. A partial line is rejected by the host decoder. */
    usb_serial_jtag_write_bytes(data, len, pdMS_TO_TICKS(20));
}

static int ina_read(void *ctx, uint8_t addr, uint8_t reg, uint16_t *value) {
    (void)ctx;
    if (addr != CONFIG_HWDOG_INA226_ADDR) return -1;
    uint8_t buf[2];
    if (i2c_master_transmit_receive(ina226, &reg, 1, buf, 2, 10) != ESP_OK) return -1;
    *value = (uint16_t)((buf[0] << 8) | buf[1]);
    return 0;
}

static int ina_write(void *ctx, uint8_t addr, uint8_t reg, uint16_t value) {
    (void)ctx;
    if (addr != CONFIG_HWDOG_INA226_ADDR) return -1;
    uint8_t buf[3] = {reg, (uint8_t)(value >> 8), (uint8_t)(value & 0xFF)};
    return i2c_master_transmit(ina226, buf, sizeof buf, 10) == ESP_OK ? 0 : -1;
}

static int target_probe(void *ctx, uint8_t addr) {
    (void)ctx;
    switch (i2c_master_probe(target_bus, addr, 10)) {
    case ESP_OK: return HDP_I2C_ACK;
    case ESP_ERR_NOT_FOUND: return HDP_I2C_NACK;
    default: return HDP_I2C_TIMEOUT; /* the bus itself failed */
    }
}

/* Idle levels of the target bus. Without pull-ups a line can also float
   high: a stuck-low line is certain, a floating one is not seen here. */
static int target_lines(void *ctx, bool *sda, bool *scl) {
    (void)ctx;
    *sda = gpio_get_level(CONFIG_HWDOG_TGT_SDA) != 0;
    *scl = gpio_get_level(CONFIG_HWDOG_TGT_SCL) != 0;
    return 0;
}

static int uart_baud(void *ctx, uint32_t baud) {
    (void)ctx;
    return uart_set_baudrate(TARGET_UART, baud) == ESP_OK ? 0 : -1;
}

static void uart_tx(void *ctx, const char *data, size_t len) {
    (void)ctx;
    uart_write_bytes(TARGET_UART, data, len);
}

/* NVS holds the calibration (and the Wi-Fi driver's data): always started,
   network or not. */
static void nvs_start(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
}

/* ------------------------------------------------------------ setup */

static void buses_start(void) {
    i2c_master_bus_config_t pb = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = CONFIG_HWDOG_PWR_SDA,
        .scl_io_num = CONFIG_HWDOG_PWR_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&pb, &power_bus));
    i2c_device_config_t dev = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = CONFIG_HWDOG_INA226_ADDR,
        .scl_speed_hz = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(power_bus, &dev, &ina226));

    i2c_master_bus_config_t tb = pb;
    tb.i2c_port = I2C_NUM_1;
    tb.sda_io_num = CONFIG_HWDOG_TGT_SDA;
    tb.scl_io_num = CONFIG_HWDOG_TGT_SCL;
    tb.flags.enable_internal_pullup = false; /* the target bus has its own pull-ups */
    ESP_ERROR_CHECK(i2c_new_master_bus(&tb, &target_bus));

    uart_config_t u = {
        .baud_rate = 115200,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(TARGET_UART, 4096, 0, 32, &uart_events, 0));
    ESP_ERROR_CHECK(uart_param_config(TARGET_UART, &u));
    ESP_ERROR_CHECK(uart_set_pin(TARGET_UART, CONFIG_HWDOG_UART_TX, CONFIG_HWDOG_UART_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    usb_serial_jtag_driver_config_t usb = USB_SERIAL_JTAG_DRIVER_CONFIG_DEFAULT();
    usb.rx_buffer_size = 1024;
    usb.tx_buffer_size = 4096;
    ESP_ERROR_CHECK(usb_serial_jtag_driver_install(&usb));
}

static void drain_uart(hdp_device_t *d) {
    uart_event_t e;
    static char buf[256];
    while (xQueueReceive(uart_events, &e, 0) == pdTRUE) {
        switch (e.type) {
        case UART_DATA: {
            size_t left = e.size;
            while (left > 0) {
                int n = uart_read_bytes(TARGET_UART, buf, left < sizeof buf ? left : sizeof buf, 0);
                if (n <= 0) break;
                hdp_uart_input(d, buf, (size_t)n);
                left -= (size_t)n;
            }
            break;
        }
        case UART_FRAME_ERR: hdp_uart_error(d, "framing"); break;
        case UART_PARITY_ERR: hdp_uart_error(d, "parity"); break;
        case UART_BREAK: hdp_uart_error(d, "break"); break;
        case UART_FIFO_OVF:
        case UART_BUFFER_FULL:
            /* Bytes were lost: say so, then start clean. */
            hdp_uart_error(d, "overrun");
            uart_flush_input(TARGET_UART);
            xQueueReset(uart_events);
            return;
        default: break;
        }
    }
}

/* Calibration kept in NVS, so a calibrated board stays calibrated. */
#define CAL_NS "hwdog"
#define CAL_KEY "cal"

static int cal_load(void *ctx, hdp_cal_t *out) {
    (void)ctx;
    nvs_handle_t h;
    if (nvs_open(CAL_NS, NVS_READONLY, &h) != ESP_OK) return -1;
    size_t len = sizeof *out;
    esp_err_t err = nvs_get_blob(h, CAL_KEY, out, &len);
    nvs_close(h);
    return err == ESP_OK && len == sizeof *out && out->valid ? 0 : -1;
}

static int cal_save(void *ctx, const hdp_cal_t *cal) {
    (void)ctx;
    nvs_handle_t h;
    if (nvs_open(CAL_NS, NVS_READWRITE, &h) != ESP_OK) return -1;
    esp_err_t err = cal->valid ? nvs_set_blob(h, CAL_KEY, cal, sizeof *cal) : nvs_erase_key(h, CAL_KEY);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK; /* nothing to erase */
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err == ESP_OK ? 0 : -1;
}

void app_main(void) {
    nvs_start();
    buses_start();
    bool net = hwnet_start();

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    static char device_id[16];
    snprintf(device_id, sizeof device_id, "HD-%02X%02X%02X", mac[3], mac[4], mac[5]);
    /* The identity dogd keys on: the 48-bit factory MAC burnt in eFuse. The
     * short device id above is for people (24 bits, not unique). */
    static char chip_id[13];
    uint8_t efuse[6] = {0};
    if (esp_efuse_mac_get_default(efuse) == ESP_OK)
        snprintf(chip_id, sizeof chip_id, "%02x%02x%02x%02x%02x%02x", efuse[0], efuse[1], efuse[2], efuse[3], efuse[4], efuse[5]);

    hdp_config_t cfg = {
        .device = device_id,
        .chip = chip_id[0] ? chip_id : NULL,
        .rev = "DEVKIT-S3", /* a dev board, not Rev A: said as it is */
        .fw = FW_VERSION,
        .ina_addr = CONFIG_HWDOG_INA226_ADDR,
        .shunt_ohm = (float)CONFIG_HWDOG_SHUNT_MOHM / 1000.0f,
        .max_current_a = (float)CONFIG_HWDOG_MAX_CURRENT_MA / 1000.0f,
        .sample_ms = 20,
        .net_ms = 2000,
        .caps = HDP_CAP_POWER | HDP_CAP_UART | HDP_CAP_I2C | (net ? HDP_CAP_NET | HDP_CAP_PROBE : 0),
        .shunt_tol_pct = (float)CONFIG_HWDOG_SHUNT_TOL_PERMILLE / 10.0f,
        .i2c_watch_ms = CONFIG_HWDOG_I2C_WATCH_MS,
    };
    hdp_hal_t hal = {
        .now_ms = now_ms,
        .write = link_write,
        .ina_read = ina_read,
        .ina_write = ina_write,
        .target_i2c_probe = target_probe,
        .target_i2c_lines = target_lines,
        .target_i2c_hz = TARGET_I2C_HZ,
        .uart_set_baud = uart_baud,
        .uart_write = uart_tx,
        .net_status = net ? hwnet_status : NULL,
        .net_watch = net ? hwnet_watch : NULL,
        .probe_start = net ? hwnet_probe_start : NULL,
        .cal_load = cal_load,
        .cal_save = cal_save,
    };
    static hdp_device_t dev;
    hdp_init(&dev, &cfg, &hal);
    hdp_start(&dev);

    static char rx[256];
    for (;;) {
        /* The 2 ms wait on the host link paces the loop. */
        int n = usb_serial_jtag_read_bytes(rx, sizeof rx, pdMS_TO_TICKS(2));
        if (n > 0) hdp_host_input(&dev, rx, (size_t)n);
        drain_uart(&dev);
        if (hwnet_take_changed()) hdp_net_changed(&dev);
        hwnet_drain_probes(&dev);
        hdp_poll(&dev);
    }
}
