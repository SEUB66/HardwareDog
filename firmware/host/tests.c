/*
 * Unit tests of the firmware core, on a PC. Run: ctest (host/build).
 * The HDP v1 contract itself is checked by web/test/firmware.test.ts on
 * everything hwdog-host prints.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "hdp/hdp.h"

static int failures = 0;
#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                    \
        }                                                                  \
    } while (0)

/* ---- a fake board that records every line written ---- */

typedef struct {
    char out[65536];
    size_t len;
    uint32_t t;
    uint16_t man, die, config, cal;
    float v, i, shunt;
    bool nack;
    uint32_t baud;
    char tx[256];
    size_t tx_len;
} board_t;

static uint32_t b_now(void *c) { return ((board_t *)c)->t; }
static void b_write(void *c, const char *d, size_t n) {
    board_t *b = c;
    if (b->len + n < sizeof b->out) {
        memcpy(b->out + b->len, d, n);
        b->len += n;
        b->out[b->len] = '\0';
    }
}
static int b_read(void *c, uint8_t a, uint8_t reg, uint16_t *v) {
    board_t *b = c;
    if (b->nack || a != 0x40) return -1;
    int16_t shunt = (int16_t)lroundf(b->i * b->shunt / 2.5e-6f);
    switch (reg) {
    case 0x02: *v = (uint16_t)lroundf(b->v / 0.00125f); return 0;
    case 0x04: *v = (uint16_t)(int16_t)((int32_t)shunt * b->cal / 2048); return 0;
    case 0xFE: *v = b->man; return 0;
    case 0xFF: *v = b->die; return 0;
    default: return -1;
    }
}
static int b_write_reg(void *c, uint8_t a, uint8_t reg, uint16_t v) {
    board_t *b = c;
    if (b->nack || a != 0x40) return -1;
    if (reg == 0) b->config = v;
    if (reg == 5) b->cal = v;
    return 0;
}
static int b_probe(void *c, uint8_t a) {
    (void)c;
    return a == 0x3C || a == 0x76 ? 0 : -1;
}
static int b_baud(void *c, uint32_t baud) {
    if (baud == 12345) return -1;
    ((board_t *)c)->baud = baud;
    return 0;
}
static void b_tx(void *c, const char *d, size_t n) {
    board_t *b = c;
    memcpy(b->tx + b->tx_len, d, n);
    b->tx_len += n;
}

static board_t B;
static hdp_device_t D;

static void setup(void) {
    memset(&B, 0, sizeof B);
    B.man = 0x5449;
    B.die = 0x2260;
    B.v = 5.05f;
    B.i = 0.112f;
    B.shunt = 0.1f;
    hdp_config_t cfg = {.device = "HD-TEST", .rev = "T", .fw = "0.1.0", .ina_addr = 0x40, .shunt_ohm = 0.1f, .max_current_a = 0.8f, .sample_ms = 20, .net_ms = 0,
                       .caps = HDP_CAP_POWER | HDP_CAP_UART | HDP_CAP_I2C};
    hdp_hal_t hal = {.ctx = &B, .now_ms = b_now, .write = b_write, .ina_read = b_read, .ina_write = b_write_reg, .target_i2c_probe = b_probe,
                     .target_i2c_hz = 100000, .uart_set_baud = b_baud, .uart_write = b_tx, .net_status = NULL};
    hdp_init(&D, &cfg, &hal);
}

static void clear(void) {
    B.len = 0;
    B.out[0] = '\0';
}

static bool has(const char *needle) { return strstr(B.out, needle) != NULL; }

/* every line ends with \n and is one JSON object */
static bool lines_well_formed(void) {
    const char *p = B.out;
    while (*p) {
        const char *nl = strchr(p, '\n');
        if (!nl || p[0] != '{' || nl[-1] != '}') return false;
        p = nl + 1;
    }
    return true;
}

static void test_boot_and_power(void) {
    setup();
    hdp_start(&D);
    CHECK(has("{\"type\":\"hello\",\"t\":0,\"proto\":1,\"device\":\"HD-TEST\",\"rev\":\"T\",\"fw\":\"0.1.0\",\"caps\":[\"power\",\"uart\",\"i2c\"]}\n"));
    CHECK(has("\"type\":\"uart.config\""));
    CHECK(has("\"link\":null")); /* no network on this board: said, not guessed */
    CHECK(has("INA226 at 0x40 verified"));
    CHECK(B.config == hdp_ina226_config_word());
    CHECK(B.cal == hdp_ina226_calibration(0.1f, 0.8f, NULL));
    clear();
    B.t = 20;
    hdp_poll(&D);
    CHECK(has("{\"type\":\"power\",\"t\":20,\"v\":5.050,\"i\":0.1120}\n"));
    CHECK(lines_well_formed());
}

static void test_calibration(void) {
    float lsb;
    uint16_t cal = hdp_ina226_calibration(0.1f, 0.8f, &lsb);
    CHECK(cal == 2097);
    CHECK(fabsf(lsb - 24.4e-6f) < 0.1e-6f);
    /* config: AVG 4, 1.1 ms conversions, continuous */
    CHECK(hdp_ina226_config_word() == 0x4327);
}

static void test_current_accuracy_through_the_chip_math(void) {
    for (float amps = 0.01f; amps < 0.8f; amps += 0.037f) {
        setup();
        B.i = amps;
        hdp_start(&D);
        clear();
        B.t = 20;
        hdp_poll(&D);
        const char *p = strstr(B.out, "\"i\":");
        CHECK(p != NULL);
        float got = p ? strtof(p + 4, NULL) : -1;
        CHECK(fabsf(got - amps) < 0.0002f); /* within 0.2 mA: quantization, not invention */
    }
}

static void test_ina_missing_or_wrong(void) {
    setup();
    B.nack = true;
    hdp_start(&D);
    CHECK(has("INA226 not answering at 0x40: power monitor offline"));
    clear();
    B.t = 100;
    hdp_poll(&D);
    CHECK(!has("\"type\":\"power\"")); /* no chip, no numbers */

    setup();
    B.man = 0x1234;
    hdp_start(&D);
    CHECK(has("is not an INA226 (manufacturer 0x1234"));
    clear();
    B.t = 100;
    hdp_poll(&D);
    CHECK(!has("\"type\":\"power\""));
}

static void test_read_failure_stops_power(void) {
    setup();
    hdp_start(&D);
    B.nack = true;
    clear();
    B.t = 20;
    hdp_poll(&D);
    CHECK(has("INA226 read failed"));
    CHECK(!has("\"type\":\"power\""));
}

static void test_time_never_goes_backwards(void) {
    setup();
    B.t = 500;
    hdp_start(&D);
    B.t = 100; /* a clock that jumps back */
    clear();
    hdp_host_input(&D, "{\"cmd\":\"net.refresh\"}\n", 22);
    CHECK(has("\"t\":500"));
}

static void test_commands(void) {
    setup();
    hdp_start(&D);
    clear();
    const char *c1 = "{\"cmd\":\"i2c.scan\"}\n";
    hdp_host_input(&D, c1, strlen(c1));
    CHECK(has("\"devices\":[{\"addr\":60,\"ident\":null,\"method\":null},{\"addr\":118,\"ident\":null,\"method\":null}]"));
    clear();
    /* any chunking, CRLF tolerated */
    const char *c2 = "{\"cmd\":\"uart.config\",\"baud\":9600}\r\n";
    for (size_t k = 0; k < strlen(c2); k++) hdp_host_input(&D, c2 + k, 1);
    CHECK(B.baud == 9600);
    CHECK(has("\"baud\":9600"));
    clear();
    const char *c3 = "{\"cmd\":\"uart.tx\",\"data\":\"AT+RST \\u00e9\\ud83d\\ude00\"}\n";
    hdp_host_input(&D, c3, strlen(c3));
    CHECK(B.tx_len == strlen("AT+RST \xc3\xa9\xf0\x9f\x98\x80\r\n") && memcmp(B.tx, "AT+RST \xc3\xa9\xf0\x9f\x98\x80\r\n", B.tx_len) == 0);
    clear();
    const char *c4 = "{\"cmd\":\"probe\",\"id\":\"p1\",\"target\":\"192.168.1.1\",\"tests\":[\"PING\",\"DNS\"]}\n";
    hdp_host_input(&D, c4, strlen(c4));
    CHECK(has("\"test\":\"PING\",\"status\":\"UNKNOWN\",\"detail\":\"not available on this firmware\""));
    CHECK(has("{\"type\":\"probe.done\""));
    clear();
    hdp_host_input(&D, "{\"cmd\":\"usb.enumerate\"}\n", 24);
    CHECK(has("no USB host port"));
    clear();
    hdp_host_input(&D, "{\"cmd\":\"hello\",\"proto\":1}\n", 26);
    CHECK(has("\"type\":\"hello\"") && has("\"type\":\"uart.config\"") && has("\"type\":\"net.status\""));
    CHECK(lines_well_formed());
}

static void test_hostile_commands(void) {
    setup();
    hdp_start(&D);
    const char *bad[] = {
        "not json\n", "{\"cmd\":\"uart.config\",\"baud\":12.5}\n", "{\"cmd\":\"uart.config\",\"baud\":1e99}\n", "{\"cmd\":\"uart.config\"}\n",
        "{\"cmd\":\"nope\"}\n", "{\"cmd\":\"i2c.scan\"} trailing\n", "{\"cmd\":{\"nested\":1}}\n", "[1,2,3]\n", "{\"cmd\":\"uart.tx\",\"data\":\"\\x\"}\n",
        "{\"cmd\":\"probe\",\"id\":\"p\",\"target\":\"x\",\"tests\":[\"WARP\"]}\n",
    };
    for (size_t k = 0; k < sizeof bad / sizeof *bad; k++) {
        clear();
        hdp_host_input(&D, bad[k], strlen(bad[k]));
        CHECK(has("command rejected"));
        CHECK(lines_well_formed());
    }
    CHECK(B.baud == 0); /* nothing applied */
    /* longer than the line limit */
    clear();
    char big[3000];
    memset(big, 'a', sizeof big);
    hdp_host_input(&D, big, sizeof big);
    hdp_host_input(&D, "\n", 1);
    CHECK(has("longer than 1024 bytes"));
    /* the UART refusing a rate is reported, the old rate kept */
    clear();
    hdp_host_input(&D, "{\"cmd\":\"uart.config\",\"baud\":12345}\n", 35);
    CHECK(has("refused this baud rate"));
}

static void test_uart_rx(void) {
    setup();
    hdp_start(&D);
    clear();
    const char raw[] = "temp \"23\"\tok\r\nbad \xff\xfe utf8 \xc3\xa9\n";
    hdp_uart_input(&D, raw, sizeof raw - 1);
    CHECK(has("\"data\":\"temp \\\"23\\\"\\tok\"}"));
    CHECK(has("\"data\":\"bad \\ufffd\\ufffd utf8 \xc3\xa9\"}"));
    clear();
    char longline[1200];
    memset(longline, 'z', sizeof longline);
    hdp_uart_input(&D, longline, sizeof longline);
    hdp_uart_input(&D, "\n", 1);
    /* split at 512, nothing dropped: 512 + 512 + 176 */
    int frames = 0;
    for (const char *p = B.out; (p = strstr(p, "uart.rx")); p++) frames++;
    CHECK(frames == 3);
    clear();
    hdp_uart_error(&D, "framing");
    CHECK(has("{\"type\":\"uart.error\",\"t\":0,\"kind\":\"framing\"}\n"));
}

static void test_json_string(void) {
    char out[64];
    CHECK(hdp_json_string(out, sizeof out, "a\"b\\c\x01", 6) > 0 && !strcmp(out, "\"a\\\"b\\\\c\\u0001\""));
    /* overlong encodings and surrogates are not valid UTF-8 */
    CHECK(hdp_json_string(out, sizeof out, "\xc0\xaf\xed\xa0\x80", 5) > 0 && !strcmp(out, "\"\\ufffd\\ufffd\\ufffd\\ufffd\\ufffd\""));
    /* does not overflow: refuses */
    char tiny[4];
    CHECK(hdp_json_string(tiny, sizeof tiny, "abcdef", 6) == 0);
}

int main(void) {
    test_calibration();
    test_boot_and_power();
    test_current_accuracy_through_the_chip_math();
    test_ina_missing_or_wrong();
    test_read_failure_stops_power();
    test_time_never_goes_backwards();
    test_commands();
    test_hostile_commands();
    test_uart_rx();
    test_json_string();
    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("firmware core: all checks passed\n");
    return 0;
}
