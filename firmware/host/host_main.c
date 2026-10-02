/*
 * HARDWARE DOG / FIRMWARE CORE ON A PC
 *
 * Runs the exact firmware core (components/hdp) against simulated
 * hardware, so it can be tested against the HDP v1 contract without a
 * board. The INA226 is simulated at the register level, like the real
 * chip: current register = shunt register x calibration / 2048.
 *
 * This is not the device. Everything that depends on silicon (I2C timing,
 * UART electrical behaviour, USB, Wi-Fi) is verified only on real
 * hardware: docs/FIRMWARE.md, bring-up.
 *
 *   hwdog-host [--scenario healthy|sag|serial|noina|wrongchip|i2cflaky|nopullup|router]
 *              [--seconds N] [--fast] [--seed N]
 *              [--tcp PORT] [--wait-hello N]
 */
#define _POSIX_C_SOURCE 200809L
#include <arpa/inet.h>
#include <errno.h>
#include <math.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "hdp/hdp.h"

typedef enum { HEALTHY, SAG, SERIAL, NOINA, WRONGCHIP, I2CFLAKY, NOPULLUP, ROUTER } scenario_t;

typedef struct {
    scenario_t scenario;
    bool fast;
    uint32_t vt; /* virtual time, fast mode */
    struct timespec t0;
    uint32_t seed;
    int out_fd, in_fd;
    /* INA226 registers */
    uint16_t config, cal;
    float shunt_ohm;
    /* target UART */
    uint32_t baud;
    /* calibration storage (the NVS of the device) */
    hdp_cal_t stored_cal;
    /* network checks (net.watch) and background probes */
    uint32_t net_watch_ms;
    bool watch_dns, watch_upstream;
    int net_phase; /* router: 0 up, 1 down, 2 link, 3 DHCP */
    struct {
        char id[64], target[64], tests[8][16];
        int n, next;
        uint32_t at;
    } probe;
} sim_t;

static uint32_t rnd(sim_t *s) {
    s->seed ^= s->seed << 13;
    s->seed ^= s->seed >> 17;
    s->seed ^= s->seed << 5;
    return s->seed;
}
static float noise(sim_t *s, float amp) { return ((float)(rnd(s) % 2001) / 1000.0f - 1.0f) * amp; }

static uint32_t now_ms(void *ctx) {
    sim_t *s = ctx;
    if (s->fast) return s->vt;
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint32_t)((t.tv_sec - s->t0.tv_sec) * 1000 + (t.tv_nsec - s->t0.tv_nsec) / 1000000);
}

static void write_all(int fd, const char *p, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            exit(0); /* the host went away */
        }
        p += w;
        n -= (size_t)w;
    }
}

static void sleep_1ms(void) {
    struct timespec d = {0, 1000000};
    nanosleep(&d, NULL);
}

static void out(void *ctx, const char *data, size_t len) { write_all(((sim_t *)ctx)->out_fd, data, len); }

/* The rail as the target sees it at time t. */
static void rail(sim_t *s, uint32_t t, float *v, float *i) {
    *v = 5.05f + noise(s, 0.004f);
    *i = 0.112f + noise(s, 0.003f);
    if ((s->scenario == SAG || s->scenario == ROUTER) && t >= 3000 && (t - 3000) % 9000 < 600) {
        /* load burst through a resistive cable: the rail sags */
        *i = 0.70f + noise(s, 0.01f);
        *v = 4.62f + noise(s, 0.01f);
    }
}

static int ina_read(void *ctx, uint8_t addr, uint8_t reg, uint16_t *value) {
    sim_t *s = ctx;
    if (addr != 0x40 || s->scenario == NOINA) return -1; /* NACK */
    float v, i;
    rail(s, now_ms(s), &v, &i);
    switch (reg) {
    case 0x00: *value = s->config; return 0;
    case 0x02: *value = (uint16_t)lroundf(v / 0.00125f); return 0;
    case 0x01: *value = (uint16_t)(int16_t)lroundf(i * s->shunt_ohm / 2.5e-6f); return 0;
    case 0x04: {
        int16_t shunt = (int16_t)lroundf(i * s->shunt_ohm / 2.5e-6f);
        *value = (uint16_t)(int16_t)((int32_t)shunt * s->cal / 2048);
        return 0;
    }
    case 0x05: *value = s->cal; return 0;
    case 0xFE: *value = s->scenario == WRONGCHIP ? 0x1234 : 0x5449; return 0;
    case 0xFF: *value = 0x2260; return 0;
    default: return -1;
    }
}

static int ina_write(void *ctx, uint8_t addr, uint8_t reg, uint16_t value) {
    sim_t *s = ctx;
    if (addr != 0x40 || s->scenario == NOINA) return -1;
    if (reg == 0x00) s->config = value;
    else if (reg == 0x05) s->cal = value;
    else return -1;
    return 0;
}

/* Target bus: an SSD1306 display and a BME280 sensor. In i2cflaky the
   BME280 sits on a loose wire: off the bus 4 s out of every 10. */
static int i2c_probe(void *ctx, uint8_t addr) {
    sim_t *s = ctx;
    if (addr == 0x76 && s->scenario == I2CFLAKY && now_ms(s) % 10000 >= 6000) return HDP_I2C_NACK;
    return addr == 0x3C || addr == 0x76 ? HDP_I2C_ACK : HDP_I2C_NACK;
}

/* nopullup: nothing pulls the lines up, SDA reads low at idle. */
static int i2c_lines(void *ctx, bool *sda, bool *scl) {
    sim_t *s = ctx;
    *sda = s->scenario != NOPULLUP;
    *scl = true;
    return 0;
}

static int uart_set_baud(void *ctx, uint32_t baud) {
    ((sim_t *)ctx)->baud = baud;
    return 0;
}

static void uart_write(void *ctx, const char *data, size_t len) {
    (void)ctx;
    (void)data;
    (void)len; /* the simulated target ignores what it is sent */
}

/* What the target prints on its UART. */
static void target_uart(sim_t *s, hdp_device_t *d, uint32_t t) {
    if (s->scenario == SERIAL && s->baud != 9600) {
        /* the target runs at 9600: at any other rate, garbage and framing errors */
        if (t % 400 == 0) {
            const char junk[] = {(char)0xff, (char)0xfe, 'x', (char)0x80, '\n'};
            hdp_uart_error(d, "framing");
            hdp_uart_input(d, junk, sizeof junk);
        }
        return;
    }
    if (t == 180) {
        const char *boot = "ESP-ROM:esp32s3-20210327\r\nrst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\r\n";
        hdp_uart_input(d, boot, strlen(boot));
    }
    if (t > 0 && t % 3000 == 0) {
        char line[64];
        int n = snprintf(line, sizeof line, "sensor: t=%.1fC rh=%u%%\r\n", 23.5 + (double)noise(s, 0.5f), 40 + rnd(s) % 3);
        hdp_uart_input(d, line, (size_t)n);
    }
}

/* router: the network device behind the port is powered by the rail. Each
   burst browns it out: link down 300 ms after the sag, back 3 s later,
   DHCP 1.2 s after that, DNS 0.5 s after DHCP. */
static int router_phase(uint32_t t) {
    if (t < 3000) return 0;
    uint32_t k = (t - 3000) % 9000;
    if (k < 300) return 0;
    if (k < 3300) return 1;
    if (k < 4500) return 2;
    if (k < 5000) return 3;
    return 0;
}

static void net_status(void *ctx, hdp_net_t *n) {
    sim_t *s = ctx;
    int phase = s->scenario == ROUTER ? router_phase(now_ms(s)) : 0;
    n->link_present = true;
    n->link_up = phase != 1;
    if (phase == 1) {
        n->dhcp = HDP_CHECK_UNKNOWN;
        return;
    }
    n->dhcp = phase == 2 ? HDP_CHECK_PENDING : HDP_CHECK_PASS;
    if (phase == 2) return;
    strcpy(n->address, "192.168.1.42");
    strcpy(n->gateway, "192.168.1.1");
    strcpy(n->dns, "192.168.1.1");
    if (s->net_watch_ms || s->scenario == ROUTER) {
        n->gateway_status = HDP_CHECK_PASS;
        n->latency_ms = 2;
        n->loss_pct = 0;
        n->dns_status = phase == 3 ? HDP_CHECK_PENDING : s->watch_dns || s->scenario == ROUTER ? HDP_CHECK_PASS : HDP_CHECK_UNKNOWN;
        n->internet = phase == 3 ? HDP_CHECK_UNKNOWN : s->watch_upstream || s->scenario == ROUTER ? HDP_CHECK_PASS : HDP_CHECK_UNKNOWN;
    }
}

static int net_watch(void *ctx, uint32_t every_ms, const char *dns, const char *upstream) {
    sim_t *s = ctx;
    s->net_watch_ms = every_ms;
    s->watch_dns = dns != NULL;
    s->watch_upstream = upstream != NULL;
    return 0;
}

/* Probes answer from a simulated LAN, one test every 50 ms. A test fixture,
   not a network: names ending in .invalid do not resolve (RFC 6761). */
static int probe_start(void *ctx, const char *id, const char *target, const char (*tests)[16], int n) {
    sim_t *s = ctx;
    snprintf(s->probe.id, sizeof s->probe.id, "%s", id);
    snprintf(s->probe.target, sizeof s->probe.target, "%s", target);
    for (int k = 0; k < n && k < 8; k++) snprintf(s->probe.tests[k], 16, "%s", tests[k]);
    s->probe.n = n < 8 ? n : 8;
    s->probe.next = 0;
    s->probe.at = now_ms(s) + 50;
    return 0;
}

static void probe_poll(sim_t *s, hdp_device_t *d) {
    if (s->probe.n == 0 || now_ms(s) < s->probe.at) return;
    if (s->probe.next == s->probe.n) {
        hdp_probe_done(d, s->probe.id);
        s->probe.n = 0;
        return;
    }
    const char *test = s->probe.tests[s->probe.next++];
    size_t len = strlen(s->probe.target);
    bool invalid = len >= 8 && !strcmp(s->probe.target + len - 8, ".invalid");
    if (invalid) hdp_probe_result(d, s->probe.id, test, HDP_CHECK_FAIL, "name does not resolve");
    else if (!strcmp(test, "PING")) hdp_probe_result(d, s->probe.id, test, HDP_CHECK_PASS, "4/4 replies, avg 2 ms");
    else if (!strcmp(test, "DNS")) hdp_probe_result(d, s->probe.id, test, HDP_CHECK_PASS, "resolved");
    else if (!strcmp(test, "TCP")) hdp_probe_result(d, s->probe.id, test, HDP_CHECK_PASS, "port 80 open");
    else hdp_probe_result(d, s->probe.id, test, HDP_CHECK_PASS, "HTTP/1.1 200 OK");
    s->probe.at = now_ms(s) + 50;
}

static int cal_load(void *ctx, hdp_cal_t *out) {
    sim_t *s = ctx;
    if (!s->stored_cal.valid) return -1;
    *out = s->stored_cal;
    return 0;
}

static int cal_save(void *ctx, const hdp_cal_t *cal) {
    ((sim_t *)ctx)->stored_cal = *cal;
    return 0;
}

static int listen_once(int port) {
    int srv = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
    if (bind(srv, (struct sockaddr *)&a, sizeof a) != 0 || listen(srv, 1) != 0) {
        perror("listen");
        exit(2);
    }
    fprintf(stderr, "LISTEN 127.0.0.1:%d\n", port);
    int c = accept(srv, NULL, NULL);
    close(srv);
    return c;
}

/* Read what the host sent, without blocking. Returns false at end of input. */
static bool host_input(sim_t *s, hdp_device_t *d, int *hellos_to_wait) {
    struct pollfd p = {.fd = s->in_fd, .events = POLLIN};
    while (poll(&p, 1, 0) > 0) {
        if (!(p.revents & (POLLIN | POLLHUP))) break;
        char buf[512];
        ssize_t n = read(s->in_fd, buf, sizeof buf);
        if (n <= 0) return false;
        if (*hellos_to_wait > 0) {
            for (ssize_t k = 0; k + 5 <= n; k++)
                if (memcmp(buf + k, "hello", 5) == 0 && --*hellos_to_wait == 0) break;
            continue;
        }
        hdp_host_input(d, buf, (size_t)n);
    }
    return true;
}

int main(int argc, char **argv) {
    sim_t s = {.scenario = HEALTHY, .seed = 4, .out_fd = 1, .in_fd = 0, .shunt_ohm = 0.1f, .baud = 115200, .config = 0x4127};
    uint32_t seconds = 30;
    int port = 0, wait_hello = 0;
    for (int k = 1; k < argc; k++) {
        const char *a = argv[k];
        const char *v = k + 1 < argc ? argv[k + 1] : "";
        if (!strcmp(a, "--fast")) s.fast = true;
        else if (!strcmp(a, "--seconds")) seconds = (uint32_t)atoi(v), k++;
        else if (!strcmp(a, "--seed")) s.seed = (uint32_t)atoi(v) | 1u, k++;
        else if (!strcmp(a, "--tcp")) port = atoi(v), k++;
        else if (!strcmp(a, "--wait-hello")) wait_hello = atoi(v), k++;
        else if (!strcmp(a, "--scenario")) {
            const char *names[] = {"healthy", "sag", "serial", "noina", "wrongchip", "i2cflaky", "nopullup", "router"};
            bool found = false;
            for (int i = 0; i < 8; i++)
                if (!strcmp(v, names[i])) s.scenario = (scenario_t)i, found = true;
            if (!found) {
                fprintf(stderr, "unknown scenario %s\n", v);
                return 2;
            }
            k++;
        } else {
            fprintf(stderr, "usage: hwdog-host [--scenario NAME] [--seconds N] [--fast] [--seed N] [--tcp PORT] [--wait-hello N]\n");
            return 2;
        }
    }
    if (port) s.out_fd = s.in_fd = listen_once(port);
    clock_gettime(CLOCK_MONOTONIC, &s.t0);

    hdp_config_t cfg = {.device = "HD-HOST01", .rev = "HOST", .fw = "0.1.0", .ina_addr = 0x40, .shunt_ohm = 0.1f, .max_current_a = 0.8f, .sample_ms = 20, .net_ms = 2000,
                       .caps = HDP_CAP_POWER | HDP_CAP_UART | HDP_CAP_I2C | HDP_CAP_NET | HDP_CAP_PROBE, .shunt_tol_pct = 1.0f,
                       /* the I2C scenarios model a board configured to watch its bus from boot */
                       .i2c_watch_ms = s.scenario == I2CFLAKY || s.scenario == NOPULLUP ? 3000 : 0};
    hdp_hal_t hal = {.ctx = &s, .now_ms = now_ms, .write = out, .ina_read = ina_read, .ina_write = ina_write, .target_i2c_probe = i2c_probe,
                     .target_i2c_hz = 100000, .uart_set_baud = uart_set_baud, .uart_write = uart_write, .net_status = net_status, .cal_load = cal_load, .cal_save = cal_save,
                     .target_i2c_lines = i2c_lines, .net_watch = net_watch, .probe_start = probe_start};
    hdp_device_t d;
    hdp_init(&d, &cfg, &hal);

    while (wait_hello > 0) {
        if (!host_input(&s, &d, &wait_hello)) return 0;
        sleep_1ms();
    }
    hdp_start(&d);
    uint32_t last = 0;
    bool open = true;
    while (now_ms(&s) < seconds * 1000) {
        uint32_t t = now_ms(&s);
        for (uint32_t u = last + 1; u <= t; u++) target_uart(&s, &d, u);
        last = t;
        if (open) open = host_input(&s, &d, &wait_hello);
        probe_poll(&s, &d);
        /* The network changed (router reboot): said at once, as the device does. */
        if (s.scenario == ROUTER) {
            int phase = router_phase(t);
            if (phase != s.net_phase) {
                s.net_phase = phase;
                hdp_net_changed(&d);
            }
        }
        hdp_poll(&d);
        if (s.fast) s.vt++;
        else sleep_1ms();
    }
    /* let the host read a last command (scripted tests) */
    host_input(&s, &d, &wait_hello);
    return 0;
}
