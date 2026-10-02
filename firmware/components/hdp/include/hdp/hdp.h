/*
 * HARDWARE DOG / FIRMWARE CORE
 *
 * Portable C11. No ESP-IDF, no allocation, no globals: the same code runs
 * on the ESP32-S3 (main/) and on a PC (host/), where it is tested against
 * the HDP v1 contract (protocol/hdp_v1.json) like the simulator.
 *
 * The core speaks HDP v1 and nothing else. Hardware comes in through
 * hdp_hal_t; time is the device uptime the HAL reports.
 */
#ifndef HDP_HDP_H
#define HDP_HDP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define HDP_PROTO 1
#define HDP_MAX_LINE 1024        /* longest frame this firmware writes */
#define HDP_MAX_COMMAND 1024     /* longest command line accepted */
#define HDP_MAX_UART_LINE 512    /* target UART line, split beyond */
#define HDP_MAX_I2C_DEVICES 112  /* 0x08..0x77 */

typedef enum { HDP_CHECK_PASS, HDP_CHECK_WARN, HDP_CHECK_FAIL, HDP_CHECK_PENDING, HDP_CHECK_UNKNOWN } hdp_check_t;

/* What the network side knows. link_present false = no network configured (link: null). */
typedef struct {
    bool link_present;
    bool link_up;
    char address[40];   /* "" = unknown */
    hdp_check_t dhcp;
    char gateway[40];
    char dns[40];
    /* Filled only by net.watch checks; the core sets UNKNOWN / -1 first. */
    hdp_check_t gateway_status, dns_status, internet;
    int32_t latency_ms;  /* gateway round trip, -1 = unknown */
    float loss_pct;      /* gateway ping loss, -1 = unknown */
} hdp_net_t;

/* I2C probe results (target_i2c_probe). */
enum { HDP_I2C_ACK = 0, HDP_I2C_NACK = -1, HDP_I2C_TIMEOUT = -2, HDP_I2C_ARB_LOST = -3 };

/* A calibration against a reference instrument (LVL 65). Stored by the HAL. */
typedef struct {
    bool valid;
    char date[11];  /* YYYY-MM-DD */
    char ref[65];   /* reference instrument */
    float v_gain, i_gain, i_offset;
    float v_err, i_err; /* largest residual seen against the reference (V, A) */
} hdp_cal_t;

typedef struct {
    void *ctx;
    /* Device uptime in ms. Never goes backwards. */
    uint32_t (*now_ms)(void *ctx);
    /* Write bytes to the host link (USB CDC / TCP). One call = one whole line. */
    void (*write)(void *ctx, const char *data, size_t len);
    /* Power monitor bus (INA226). Return 0 on success. */
    int (*ina_read)(void *ctx, uint8_t addr, uint8_t reg, uint16_t *value);
    int (*ina_write)(void *ctx, uint8_t addr, uint8_t reg, uint16_t value);
    /* Target I2C bus: HDP_I2C_ACK when a device ACKs the address, NACK when
       none does; TIMEOUT / ARB_LOST when the bus itself fails. */
    int (*target_i2c_probe)(void *ctx, uint8_t addr);
    /* Idle levels of the target bus lines (true = high). NULL = not readable. */
    int (*target_i2c_lines)(void *ctx, bool *sda_high, bool *scl_high);
    uint32_t target_i2c_hz;
    /* Target UART. */
    int (*uart_set_baud)(void *ctx, uint32_t baud);
    void (*uart_write)(void *ctx, const char *data, size_t len);
    /* Network state, filled on request. NULL = no network on this hardware. */
    void (*net_status)(void *ctx, hdp_net_t *out);
    /* net.watch: start (every_ms > 0) or stop periodic network checks. The
       results come back through net_status(), signalled by hdp_net_changed().
       dns / upstream may be NULL. NULL hook = no network checks here. */
    int (*net_watch)(void *ctx, uint32_t every_ms, const char *dns, const char *upstream);
    /* probe: run tests in the background; answer with hdp_probe_result() and
       hdp_probe_done() from the core's task. NULL = probes not available. */
    int (*probe_start)(void *ctx, const char *id, const char *target, const char (*tests)[16], int n);
    /* Calibration storage (NVS on the device). NULL = not kept across reboots.
       load returns 0 and fills out when a calibration is stored. */
    int (*cal_load)(void *ctx, hdp_cal_t *out);
    int (*cal_save)(void *ctx, const hdp_cal_t *cal); /* cal->valid false = erase */
} hdp_hal_t;

/* What this board can observe, announced in hello.caps (HDP v1). */
enum {
    HDP_CAP_POWER = 1 << 0,
    HDP_CAP_USB = 1 << 1,
    HDP_CAP_UART = 1 << 2,
    HDP_CAP_I2C = 1 << 3,
    HDP_CAP_NET = 1 << 4,
    HDP_CAP_PROBE = 1 << 5,
};

typedef struct {
    const char *device;   /* e.g. "HD-3A1F2C" */
    const char *rev;      /* hardware revision, e.g. "DEVKIT-S3" */
    const char *fw;       /* firmware version */
    uint8_t ina_addr;     /* 0x40 on most INA226 boards */
    float shunt_ohm;      /* shunt resistor, e.g. 0.1 */
    float max_current_a;  /* full scale, sets the current LSB */
    uint32_t sample_ms;   /* power frame period */
    uint32_t net_ms;      /* net.status period, 0 = on request only */
    uint32_t caps;        /* HDP_CAP_* this board really has */
    float shunt_tol_pct;  /* shunt resistor tolerance, % (1 for common R100 boards) */
    uint32_t i2c_watch_ms; /* periodic target bus scan from boot, 0 = on request only */
} hdp_config_t;

typedef struct {
    hdp_config_t cfg;
    hdp_hal_t hal;
    /* INA226 */
    bool ina_ok;
    float current_lsb;
    hdp_cal_t cal;
    uint32_t next_sample;
    uint32_t next_net;
    uint32_t i2c_watch_ms;
    uint32_t next_i2c;
    uint32_t last_t;
    /* target UART */
    uint32_t baud;
    char uart_line[HDP_MAX_UART_LINE + 1];
    size_t uart_len;
    /* host command line */
    char cmd[HDP_MAX_COMMAND + 1];
    size_t cmd_len;
    bool cmd_overflow;
} hdp_device_t;

void hdp_init(hdp_device_t *d, const hdp_config_t *cfg, const hdp_hal_t *hal);
/* Boot: identify the INA226, then hello + uart.config + net.status. */
void hdp_start(hdp_device_t *d);
/* Bytes from the host link (commands). Any chunking. */
void hdp_host_input(hdp_device_t *d, const char *data, size_t len);
/* Bytes received from the target UART. */
void hdp_uart_input(hdp_device_t *d, const char *data, size_t len);
/* A UART error seen by the driver: "framing", "parity", "overrun", "break". */
void hdp_uart_error(hdp_device_t *d, const char *kind);
/* Call often: samples power and sends periodic frames when due. */
void hdp_poll(hdp_device_t *d);
/* The network changed (link, address, a net.watch result): send net.status now. */
void hdp_net_changed(hdp_device_t *d);
/* Background probe results, called from the core's task. */
void hdp_probe_result(hdp_device_t *d, const char *id, const char *test, hdp_check_t status, const char *detail);
void hdp_probe_done(hdp_device_t *d, const char *id);

/* ---- exposed for tests ---- */

/* INA226 configuration and calibration values for a config. */
uint16_t hdp_ina226_config_word(void);
uint16_t hdp_ina226_calibration(float shunt_ohm, float max_current_a, float *current_lsb);

/* Append a JSON string literal (quoted, escaped, invalid UTF-8 replaced by U+FFFD). */
size_t hdp_json_string(char *out, size_t cap, const char *s, size_t len);

#endif
