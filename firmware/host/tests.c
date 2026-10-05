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
    bool sda_low, bus_timeout;
    int net_watch_calls;
    uint32_t net_watch_every;
    char probe_id[64];
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
    board_t *b = c;
    if (b->bus_timeout && a == 0x20) return HDP_I2C_TIMEOUT;
    return a == 0x3C || a == 0x76 ? HDP_I2C_ACK : HDP_I2C_NACK;
}
static int b_lines(void *c, bool *sda, bool *scl) {
    *sda = !((board_t *)c)->sda_low;
    *scl = true;
    return 0;
}
static int b_net_watch(void *c, uint32_t every, const char *dns, const char *up) {
    board_t *b = c;
    (void)dns;
    (void)up;
    b->net_watch_calls++;
    b->net_watch_every = every;
    return 0;
}
static int b_probe_start(void *c, const char *id, const char *target, const char (*tests)[16], int n) {
    (void)target;
    (void)tests;
    (void)n;
    snprintf(((board_t *)c)->probe_id, 64, "%s", id);
    return 0;
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
                       .caps = HDP_CAP_POWER | HDP_CAP_UART | HDP_CAP_I2C, .shunt_tol_pct = 1.0f};
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
    /* no network on this board: its caps say so, and it says nothing about one */
    CHECK(!has("net.status"));
    CHECK(has("INA226 at 0x40 verified"));
    CHECK(B.config == hdp_ina226_config_word());
    CHECK(B.cal == hdp_ina226_calibration(0.1f, 0.8f, NULL));
    clear();
    B.t = 20;
    hdp_poll(&D);
    CHECK(has("{\"type\":\"power\",\"t\":20,\"v\":5.050,\"i\":0.1120}\n"));
    CHECK(lines_well_formed());
}

/* The 48-bit chip id: sent when the board knows it, only well formed. */
static void test_hello_chip_id(void) {
    setup();
    D.cfg.chip = "7cdfa13a1f2c";
    hdp_start(&D);
    CHECK(has("\"fw\":\"0.1.0\",\"chip\":\"7cdfa13a1f2c\",\"caps\":"));
    const char *bad[] = {"3a1f2c", "7CDFA13A1F2C", "7cdfa13a1f2g", ""};
    for (int k = 0; k < 4; k++) {
        setup();
        D.cfg.chip = bad[k];
        hdp_start(&D);
        CHECK(has("\"type\":\"hello\"") && !has("\"chip\""));
    }
    CHECK(lines_well_formed());
}

/* time: the clock now, the same id back, at once; bad ids refused in HDP. */
static void test_time_command(void) {
    setup();
    hdp_start(&D);
    clear();
    B.t = 1234;
    const char *ok = "{\"cmd\":\"time\",\"id\":4294967295}\n";
    hdp_host_input(&D, ok, strlen(ok));
    CHECK(has("{\"type\":\"time\",\"t\":1234,\"id\":4294967295}\n"));
    const char *bad[] = {"{\"cmd\":\"time\"}\n", "{\"cmd\":\"time\",\"id\":-1}\n", "{\"cmd\":\"time\",\"id\":1.5}\n",
                         "{\"cmd\":\"time\",\"id\":4294967296}\n"};
    for (int k = 0; k < 4; k++) {
        clear();
        hdp_host_input(&D, bad[k], strlen(bad[k]));
        CHECK(has("command rejected") && !has("\"type\":\"time\""));
    }
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

static hdp_cal_t stored;
static int s_load(void *c, hdp_cal_t *out) {
    (void)c;
    if (!stored.valid) return -1;
    *out = stored;
    return 0;
}
static int s_save(void *c, const hdp_cal_t *cal) {
    (void)c;
    stored = *cal;
    return 0;
}

static void cmd(const char *line) {
    hdp_host_input(&D, line, strlen(line));
}

static void test_meter_and_calibration(void) {
    setup();
    hdp_start(&D);
    /* Datasheet worst case: 0.1 % + 7.5 mV + 1 LSB; 0.1 % + 1 % shunt tolerance. */
    CHECK(has("\"type\":\"power.meter\""));
    CHECK(has("\"sensor\":\"INA226\",\"shunt_ohm\":0.1,\"v_max\":36,\"i_max\":0.8"));
    CHECK(has("\"rate_hz\":50"));
    CHECK(has("\"v_err\":{\"pct\":0.1,\"abs\":0.00875}"));
    CHECK(has("\"i_err\":{\"pct\":1.1,"));
    CHECK(has("\"basis\":\"DATASHEET\",\"cal\":null"));

    /* A calibration out of range changes nothing. */
    clear();
    cmd("{\"cmd\":\"meter.cal\",\"date\":\"2026-10-02\",\"ref\":\"Fluke 87V\",\"v_gain\":1.5,\"i_gain\":1,\"i_offset\":0,\"v_err\":0.001,\"i_err\":0.0001}\n");
    CHECK(has("out of range, calibration unchanged"));
    CHECK(!has("power.meter"));
    clear();
    cmd("{\"cmd\":\"meter.cal\",\"date\":\"02/10/2026\",\"ref\":\"Fluke 87V\",\"v_gain\":1,\"i_gain\":1,\"i_offset\":0,\"v_err\":0.001,\"i_err\":0.0001}\n");
    CHECK(has("out of range"));

    /* A valid one is applied to every sample and declared. No storage: said. */
    clear();
    cmd("{\"cmd\":\"meter.cal\",\"date\":\"2026-10-02\",\"ref\":\"Fluke 87V\",\"v_gain\":1.02,\"i_gain\":1,\"i_offset\":0.001,\"v_err\":0.002,\"i_err\":0.0003}\n");
    CHECK(has("calibration applied but not stored: lost at reboot"));
    CHECK(has("\"basis\":\"CALIBRATION\",\"cal\":{\"date\":\"2026-10-02\",\"ref\":\"Fluke 87V\",\"v_gain\":1.02,\"i_gain\":1,\"i_offset\":0.001}"));
    CHECK(has("\"v_err\":{\"pct\":0,\"abs\":0.00325}"));
    clear();
    B.t = 20;
    hdp_poll(&D);
    CHECK(has("\"v\":5.151,\"i\":0.1130}"));
    CHECK(lines_well_formed());

    clear();
    cmd("{\"cmd\":\"meter.clear\"}\n");
    CHECK(has("calibration removed"));
    CHECK(has("\"basis\":\"DATASHEET\""));

    /* With storage, a calibration survives a reboot. */
    memset(&stored, 0, sizeof stored);
    setup();
    D.hal.cal_load = s_load;
    D.hal.cal_save = s_save;
    hdp_start(&D);
    cmd("{\"cmd\":\"meter.cal\",\"date\":\"2026-10-02\",\"ref\":\"Fluke 87V\",\"v_gain\":1.02,\"i_gain\":1,\"i_offset\":0,\"v_err\":0.002,\"i_err\":0.0003}\n");
    CHECK(has("calibration stored"));
    setup();
    D.hal.cal_load = s_load;
    D.hal.cal_save = s_save;
    hdp_start(&D);
    CHECK(has("\"basis\":\"CALIBRATION\""));

    /* No verified sensor: no meter, no calibration. */
    setup();
    B.nack = true;
    hdp_start(&D);
    CHECK(!has("power.meter"));
    clear();
    cmd("{\"cmd\":\"meter.cal\",\"date\":\"2026-10-02\",\"ref\":\"X\",\"v_gain\":1,\"i_gain\":1,\"i_offset\":0,\"v_err\":0,\"i_err\":0}\n");
    CHECK(has("no verified power sensor"));
}

static void test_i2c_watch_and_faults(void) {
    setup();
    D.hal.target_i2c_lines = b_lines;
    hdp_start(&D);
    clear();
    cmd("{\"cmd\":\"i2c.watch\",\"every_ms\":500}\n");
    CHECK(has("i2c.watch needs every_ms 0 or 1000..600000"));
    cmd("{\"cmd\":\"i2c.watch\",\"every_ms\":2000}\n");
    CHECK(has("i2c watch on"));
    clear();
    B.t = 1000;
    hdp_poll(&D);
    CHECK(!has("i2c.scan"));
    B.t = 2000;
    hdp_poll(&D);
    CHECK(has("{\"type\":\"i2c.scan\",\"t\":2000,\"speed\":100000,\"every_ms\":2000,\"devices\":[{\"addr\":60,"));

    /* A line stuck low: a fault, never an empty scan. */
    clear();
    B.sda_low = true;
    B.t = 4000;
    hdp_poll(&D);
    CHECK(has("{\"type\":\"i2c.error\",\"t\":4000,\"kind\":\"SDA_LOW\",\"detail\":\"SDA low while the bus is idle\",\"every_ms\":2000}"));
    CHECK(!has("i2c.scan"));

    /* A transfer that times out stops the scan. */
    clear();
    B.sda_low = false;
    B.bus_timeout = true;
    cmd("{\"cmd\":\"i2c.scan\"}\n");
    CHECK(has("\"kind\":\"TIMEOUT\",\"detail\":\"while probing 0x20\"}"));
    CHECK(!has("i2c.scan"));
    CHECK(lines_well_formed());

    clear();
    cmd("{\"cmd\":\"i2c.watch\",\"every_ms\":0}\n");
    CHECK(has("i2c watch off"));
    clear();
    B.t = 10000;
    hdp_poll(&D);
    CHECK(!has("i2c."));
}

static void test_network_checks_and_probes(void) {
    setup();
    D.cfg.caps |= HDP_CAP_NET | HDP_CAP_PROBE;
    hdp_start(&D);
    /* No network hook: gateway, DNS, Internet stay UNKNOWN, never guessed. */
    CHECK(has("\"gateway\":{\"address\":null,\"status\":\"UNKNOWN\"}"));
    CHECK(has("\"internet\":\"UNKNOWN\",\"latency\":null,\"loss\":null"));
    clear();
    cmd("{\"cmd\":\"net.watch\",\"every_ms\":10000,\"dns\":\"example.com\"}\n");
    CHECK(has("net.watch: no network checks on this hardware"));
    cmd("{\"cmd\":\"probe\",\"id\":\"p1\",\"target\":\"example.com\",\"tests\":[\"PING\"]}\n");
    CHECK(has("\"status\":\"UNKNOWN\",\"detail\":\"not available on this firmware\""));

    D.hal.net_watch = b_net_watch;
    D.hal.probe_start = b_probe_start;
    clear();
    cmd("{\"cmd\":\"net.watch\",\"every_ms\":10000,\"dns\":\"bad host!\"}\n");
    CHECK(has("dns and upstream are host names"));
    CHECK(B.net_watch_calls == 0);
    cmd("{\"cmd\":\"net.watch\",\"every_ms\":10000,\"dns\":\"example.com\",\"upstream\":\"example.org\"}\n");
    CHECK(B.net_watch_calls == 1 && B.net_watch_every == 10000);
    CHECK(has("net watch on"));

    /* Background probes: nothing answered in the foreground, results later. */
    clear();
    cmd("{\"cmd\":\"probe\",\"id\":\"p2\",\"target\":\"192.168.1.1\",\"tests\":[\"PING\",\"DNS\"]}\n");
    CHECK(!strcmp(B.probe_id, "p2"));
    CHECK(!has("probe.result"));
    cmd("{\"cmd\":\"probe\",\"id\":\"p3\",\"target\":\"a b\",\"tests\":[\"PING\"]}\n");
    CHECK(has("probe target must be a host name"));
    hdp_probe_result(&D, "p2", "PING", HDP_CHECK_PASS, "4/4 replies, avg 2 ms");
    hdp_probe_done(&D, "p2");
    CHECK(has("\"type\":\"probe.result\",\"t\":0,\"id\":\"p2\",\"test\":\"PING\",\"status\":\"PASS\",\"detail\":\"4/4 replies, avg 2 ms\"}"));
    CHECK(has("\"type\":\"probe.done\",\"t\":0,\"id\":\"p2\"}"));
    clear();
    hdp_net_changed(&D);
    CHECK(has("\"type\":\"net.status\""));
    CHECK(lines_well_formed());
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
    D.cfg.caps |= HDP_CAP_NET;
    B.t = 500;
    hdp_start(&D);
    B.t = 100; /* a clock that jumps back */
    clear();
    hdp_host_input(&D, "{\"cmd\":\"net.refresh\"}\n", 22);
    CHECK(has("\"t\":500"));
}

static void test_commands(void) {
    setup();
    D.cfg.caps |= HDP_CAP_NET | HDP_CAP_PROBE;
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

/* A Dog of a pack speaks only of what it declared. */
static void test_caps_are_respected(void) {
    setup();
    D.cfg.caps = HDP_CAP_NET;
    D.cfg.net_ms = 2000;
    D.i2c_watch_ms = 3000;
    hdp_start(&D);
    CHECK(has("\"caps\":[\"net\"]"));
    CHECK(has("\"type\":\"net.status\""));
    CHECK(!has("uart.config") && !has("INA226") && !has("power.meter"));
    clear();
    for (B.t = 1; B.t <= 6000; B.t++) hdp_poll(&D);
    CHECK(!has("\"type\":\"power\"") && !has("i2c.scan"));
    CHECK(has("\"type\":\"net.status\",\"t\":2000"));
    clear();
    hdp_uart_input(&D, "boot\n", 5);
    hdp_uart_error(&D, "FRAMING");
    CHECK(B.len == 0);
    cmd("{\"cmd\":\"i2c.scan\"}\n");
    CHECK(has("command rejected: i2c.scan: this Dog does not observe i2c"));
    cmd("{\"cmd\":\"uart.config\",\"baud\":9600}\n");
    CHECK(has("uart.config: this Dog does not observe uart") && B.baud == 0);
    cmd("{\"cmd\":\"meter.clear\"}\n");
    CHECK(has("meter.clear: this Dog does not observe power"));
    cmd("{\"cmd\":\"probe\",\"id\":\"p\",\"target\":\"x\",\"tests\":[\"PING\"]}\n");
    CHECK(has("probe: this Dog does not observe probe"));
    clear();
    cmd("{\"cmd\":\"hello\"}\n");
    CHECK(has("\"type\":\"hello\"") && has("net.status") && !has("uart.config"));
    clear();
    cmd("{\"cmd\":\"time\",\"id\":7}\n"); /* every Dog keeps time */
    CHECK(has("\"type\":\"time\""));
    CHECK(lines_well_formed());

    setup();
    D.cfg.caps = HDP_CAP_POWER;
    hdp_start(&D);
    CHECK(has("\"caps\":[\"power\"]") && has("power.meter"));
    CHECK(!has("net.status") && !has("uart.config"));
    hdp_net_changed(&D);
    CHECK(!has("net.status"));
    clear();
    B.t = 20;
    hdp_poll(&D);
    CHECK(has("\"type\":\"power\""));
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
    test_hello_chip_id();
    test_time_command();
    test_current_accuracy_through_the_chip_math();
    test_ina_missing_or_wrong();
    test_meter_and_calibration();
    test_i2c_watch_and_faults();
    test_network_checks_and_probes();
    test_read_failure_stops_power();
    test_time_never_goes_backwards();
    test_commands();
    test_hostile_commands();
    test_caps_are_respected();
    test_uart_rx();
    test_json_string();
    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("firmware core: all checks passed\n");
    return 0;
}
