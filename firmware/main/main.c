/*
 * HARDWARE DOG / FIRMWARE, ESP32-S3 reference device (LVL 60)
 *
 * Thin glue between the ESP-IDF drivers and the portable core
 * (components/hdp), which owns every HDP decision and is tested on a PC.
 *
 *   native USB (USB-Serial-JTAG)   HDP v1 to the host: Web Serial or dogd
 *   I2C0  GPIO 8 / 9               INA226, power of the target
 *   I2C1  GPIO 4 / 5               target I2C bus (scan on request)
 *   UART1 GPIO 18 RX / 17 TX       target UART
 *   Wi-Fi station (optional)       net.status: link, address, DHCP
 *   UART0                          ESP-IDF logs only, never HDP
 *
 * One task runs the core: no locking inside the core is needed.
 */
#include <stdio.h>
#include <string.h>

#include "driver/i2c_master.h"
#include "driver/uart.h"
#include "driver/usb_serial_jtag.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "hdp/hdp.h"
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
    return i2c_master_probe(target_bus, addr, 10) == ESP_OK ? 0 : -1;
}

static int uart_baud(void *ctx, uint32_t baud) {
    (void)ctx;
    return uart_set_baudrate(TARGET_UART, baud) == ESP_OK ? 0 : -1;
}

static void uart_tx(void *ctx, const char *data, size_t len) {
    (void)ctx;
    uart_write_bytes(TARGET_UART, data, len);
}

/* ------------------------------------------------------------ Wi-Fi */

static portMUX_TYPE net_lock = portMUX_INITIALIZER_UNLOCKED;
static hdp_net_t net_state;
static esp_netif_t *sta;

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        portENTER_CRITICAL(&net_lock);
        net_state.link_up = false;
        net_state.dhcp = HDP_CHECK_PENDING;
        net_state.address[0] = net_state.gateway[0] = net_state.dns[0] = '\0';
        portEXIT_CRITICAL(&net_lock);
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_CONNECTED) {
        portENTER_CRITICAL(&net_lock);
        net_state.link_up = true;
        net_state.dhcp = HDP_CHECK_PENDING;
        portEXIT_CRITICAL(&net_lock);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        esp_netif_dns_info_t dns = {0};
        esp_netif_get_dns_info(sta, ESP_NETIF_DNS_MAIN, &dns);
        hdp_net_t n = {.link_present = true, .link_up = true, .dhcp = HDP_CHECK_PASS};
        snprintf(n.address, sizeof n.address, IPSTR, IP2STR(&e->ip_info.ip));
        snprintf(n.gateway, sizeof n.gateway, IPSTR, IP2STR(&e->ip_info.gw));
        snprintf(n.dns, sizeof n.dns, IPSTR, IP2STR(&dns.ip.u_addr.ip4));
        portENTER_CRITICAL(&net_lock);
        net_state = n;
        portEXIT_CRITICAL(&net_lock);
    }
}

static void net_status(void *ctx, hdp_net_t *out) {
    (void)ctx;
    portENTER_CRITICAL(&net_lock);
    *out = net_state;
    portEXIT_CRITICAL(&net_lock);
}

static bool wifi_start(void) {
    if (strlen(CONFIG_HWDOG_WIFI_SSID) == 0) return false; /* no network: link null */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }
    esp_netif_init();
    esp_event_loop_create_default();
    sta = esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init) != ESP_OK) return false;
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL);
    wifi_config_t cfg = {0};
    strncpy((char *)cfg.sta.ssid, CONFIG_HWDOG_WIFI_SSID, sizeof cfg.sta.ssid - 1);
    strncpy((char *)cfg.sta.password, CONFIG_HWDOG_WIFI_PASSWORD, sizeof cfg.sta.password - 1);
    net_state = (hdp_net_t){.link_present = true, .link_up = false, .dhcp = HDP_CHECK_PENDING};
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_set_config(WIFI_IF_STA, &cfg);
    return esp_wifi_start() == ESP_OK;
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

void app_main(void) {
    buses_start();
    bool wifi = wifi_start();

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    static char device_id[16];
    snprintf(device_id, sizeof device_id, "HD-%02X%02X%02X", mac[3], mac[4], mac[5]);

    hdp_config_t cfg = {
        .device = device_id,
        .rev = "DEVKIT-S3", /* a dev board, not Rev A: said as it is */
        .fw = FW_VERSION,
        .ina_addr = CONFIG_HWDOG_INA226_ADDR,
        .shunt_ohm = (float)CONFIG_HWDOG_SHUNT_MOHM / 1000.0f,
        .max_current_a = (float)CONFIG_HWDOG_MAX_CURRENT_MA / 1000.0f,
        .sample_ms = 20,
        .net_ms = 2000,
        .caps = HDP_CAP_POWER | HDP_CAP_UART | HDP_CAP_I2C | (wifi ? HDP_CAP_NET : 0),
    };
    hdp_hal_t hal = {
        .now_ms = now_ms,
        .write = link_write,
        .ina_read = ina_read,
        .ina_write = ina_write,
        .target_i2c_probe = target_probe,
        .target_i2c_hz = TARGET_I2C_HZ,
        .uart_set_baud = uart_baud,
        .uart_write = uart_tx,
        .net_status = wifi ? net_status : NULL,
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
        hdp_poll(&dev);
    }
}
