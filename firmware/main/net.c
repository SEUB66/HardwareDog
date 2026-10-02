/*
 * HARDWARE DOG / FIRMWARE, the network side on the ESP32-S3 (LVL 80).
 *
 *   W5500 (SPI2)        the wired port, when CONFIG_HWDOG_ETH_W5500 is set
 *   Wi-Fi station       otherwise, when an SSID is configured
 *   watch task          net.watch: ping the gateway, resolve a name, open
 *                       TCP 443 to a host beyond the gateway (ACTIVE, only
 *                       when asked)
 *   probe task          probe: PING, DNS, TCP 80, HTTP GET / (ACTIVE)
 *
 * Nothing here talks to the host link: results go into `state` (read by
 * the core through hwnet_status) or the results queue (drained by the main
 * task). Nothing is sent on the network unless net.watch or probe asked.
 */
#include "net.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <unistd.h>

#include "esp_event.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "ping/ping_sock.h"
#include "sdkconfig.h"

#if CONFIG_HWDOG_ETH_W5500
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_eth.h"
#endif

static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
/* Link, address and DHCP from the events; gateway / DNS / Internet from the watch task. */
static hdp_net_t state;
static volatile bool changed;
static esp_netif_t *netif;

static SemaphoreHandle_t watch_mutex;
static TaskHandle_t watch_task;
static struct {
    uint32_t every_ms;
    char dns[254];
    char upstream[254];
} watch;

typedef struct {
    char id[64];
    char target[254];
    char tests[8][16];
    int n;
} job_t;

typedef struct {
    bool done;
    char id[64];
    char test[16];
    hdp_check_t status;
    char detail[96];
} result_t;

static QueueHandle_t jobs, results;

bool hwnet_take_changed(void) {
    if (!changed) return false;
    changed = false;
    return true;
}

void hwnet_status(void *ctx, hdp_net_t *out) {
    (void)ctx;
    portENTER_CRITICAL(&lock);
    *out = state;
    portEXIT_CRITICAL(&lock);
}

static void forget_checks(void) {
    state.gateway_status = state.dns_status = state.internet = HDP_CHECK_UNKNOWN;
    state.latency_ms = -1;
    state.loss_pct = -1;
}

/* ------------------------------------------------------------ events */

static void link_changed(bool up) {
    bool moved;
    portENTER_CRITICAL(&lock);
    moved = state.link_up != up;
    state.link_up = up;
    if (moved) {
        state.dhcp = up ? HDP_CHECK_PENDING : HDP_CHECK_UNKNOWN;
        state.address[0] = state.gateway[0] = state.dns[0] = '\0';
        forget_checks(); /* checks made before the link moved say nothing now */
    }
    portEXIT_CRITICAL(&lock);
    if (moved) changed = true;
}

static void got_ip(const esp_netif_ip_info_t *ip) {
    esp_netif_dns_info_t dns = {0};
    esp_netif_get_dns_info(netif, ESP_NETIF_DNS_MAIN, &dns);
    char a[40], g[40], d[40];
    snprintf(a, sizeof a, IPSTR, IP2STR(&ip->ip));
    snprintf(g, sizeof g, IPSTR, IP2STR(&ip->gw));
    snprintf(d, sizeof d, IPSTR, IP2STR(&dns.ip.u_addr.ip4));
    portENTER_CRITICAL(&lock);
    state.link_up = true;
    state.dhcp = HDP_CHECK_PASS;
    memcpy(state.address, a, sizeof a);
    memcpy(state.gateway, g, sizeof g);
    memcpy(state.dns, d, sizeof d);
    portEXIT_CRITICAL(&lock);
    changed = true;
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_STA_START) esp_wifi_connect();
        else if (id == WIFI_EVENT_STA_CONNECTED) link_changed(true);
        else if (id == WIFI_EVENT_STA_DISCONNECTED) {
            link_changed(false);
            esp_wifi_connect();
        }
    }
#if CONFIG_HWDOG_ETH_W5500
    else if (base == ETH_EVENT) {
        if (id == ETHERNET_EVENT_CONNECTED) link_changed(true);
        else if (id == ETHERNET_EVENT_DISCONNECTED) link_changed(false);
    }
#endif
    else if (base == IP_EVENT && (id == IP_EVENT_STA_GOT_IP || id == IP_EVENT_ETH_GOT_IP)) {
        const ip_event_got_ip_t *e = data;
        got_ip(&e->ip_info);
    }
}

/* ------------------------------------------------------------ interfaces */

#if CONFIG_HWDOG_ETH_W5500
static bool eth_start(void) {
    gpio_install_isr_service(0);
    spi_bus_config_t bus = {
        .miso_io_num = CONFIG_HWDOG_ETH_MISO,
        .mosi_io_num = CONFIG_HWDOG_ETH_MOSI,
        .sclk_io_num = CONFIG_HWDOG_ETH_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
    };
    if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) return false;
    spi_device_interface_config_t dev = {
        .mode = 0,
        .clock_speed_hz = 20 * 1000 * 1000,
        .spics_io_num = CONFIG_HWDOG_ETH_CS,
        .queue_size = 20,
    };
    eth_w5500_config_t w5500 = ETH_W5500_DEFAULT_CONFIG(SPI2_HOST, &dev);
    w5500.int_gpio_num = CONFIG_HWDOG_ETH_INT;
    if (CONFIG_HWDOG_ETH_INT < 0) w5500.poll_period_ms = 10; /* no interrupt line wired */
    eth_mac_config_t mac_cfg = ETH_MAC_DEFAULT_CONFIG();
    eth_phy_config_t phy_cfg = ETH_PHY_DEFAULT_CONFIG();
    phy_cfg.reset_gpio_num = CONFIG_HWDOG_ETH_RST;
    esp_eth_mac_t *mac = esp_eth_mac_new_w5500(&w5500, &mac_cfg);
    esp_eth_phy_t *phy = esp_eth_phy_new_w5500(&phy_cfg);
    if (!mac || !phy) return false;
    esp_eth_config_t cfg = ETH_DEFAULT_CONFIG(mac, phy);
    esp_eth_handle_t eth = NULL;
    if (esp_eth_driver_install(&cfg, &eth) != ESP_OK) return false;
    uint8_t addr[6];
    esp_read_mac(addr, ESP_MAC_ETH);
    esp_eth_ioctl(eth, ETH_CMD_S_MAC_ADDR, addr);
    esp_netif_config_t ncfg = ESP_NETIF_DEFAULT_ETH();
    netif = esp_netif_new(&ncfg);
    esp_netif_attach(netif, esp_eth_new_netif_glue(eth));
    esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_event, NULL);
    return esp_eth_start(eth) == ESP_OK;
}
#endif

static bool wifi_start(void) {
    netif = esp_netif_create_default_wifi_sta();
    wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init) != ESP_OK) return false;
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL);
    wifi_config_t cfg = {0};
    strncpy((char *)cfg.sta.ssid, CONFIG_HWDOG_WIFI_SSID, sizeof cfg.sta.ssid - 1);
    strncpy((char *)cfg.sta.password, CONFIG_HWDOG_WIFI_PASSWORD, sizeof cfg.sta.password - 1);
    esp_wifi_set_mode(WIFI_MODE_STA);
    esp_wifi_set_config(WIFI_IF_STA, &cfg);
    return esp_wifi_start() == ESP_OK;
}

/* ------------------------------------------------------------ checks */

typedef struct {
    SemaphoreHandle_t done;
    uint32_t sent, replies, rtt_sum;
} ping_ctx_t;

static void ping_ok(esp_ping_handle_t h, void *arg) {
    ping_ctx_t *p = arg;
    uint32_t gap = 0;
    esp_ping_get_profile(h, ESP_PING_PROF_TIMEGAP, &gap, sizeof gap);
    p->rtt_sum += gap;
}

static void ping_timeout(esp_ping_handle_t h, void *arg) {
    (void)h;
    (void)arg;
}

static void ping_end(esp_ping_handle_t h, void *arg) {
    ping_ctx_t *p = arg;
    esp_ping_get_profile(h, ESP_PING_PROF_REQUEST, &p->sent, sizeof p->sent);
    esp_ping_get_profile(h, ESP_PING_PROF_REPLY, &p->replies, sizeof p->replies);
    xSemaphoreGive(p->done);
}

/* ICMP echo, `count` times. False: the session could not run. */
static bool ping(const ip_addr_t *to, uint32_t count, uint32_t *sent, uint32_t *replies, uint32_t *avg_ms) {
    ping_ctx_t p = {.done = xSemaphoreCreateBinary()};
    if (!p.done) return false;
    esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
    cfg.target_addr = *to;
    cfg.count = count;
    cfg.interval_ms = 200;
    cfg.timeout_ms = 1000;
    cfg.task_stack_size = 3072;
    esp_ping_callbacks_t cbs = {.cb_args = &p, .on_ping_success = ping_ok, .on_ping_timeout = ping_timeout, .on_ping_end = ping_end};
    esp_ping_handle_t h;
    if (esp_ping_new_session(&cfg, &cbs, &h) != ESP_OK) {
        vSemaphoreDelete(p.done);
        return false;
    }
    esp_ping_start(h);
    /* Every request answered or timed out well before this. */
    bool ended = xSemaphoreTake(p.done, pdMS_TO_TICKS(count * 1300 + 3000)) == pdTRUE;
    esp_ping_stop(h);
    esp_ping_delete_session(h);
    vSemaphoreDelete(p.done);
    if (!ended) return false;
    *sent = p.sent;
    *replies = p.replies;
    *avg_ms = p.replies ? p.rtt_sum / p.replies : 0;
    return true;
}

/* An IPv4 address into lwIP's address type (dual stack or not). */
static void set_ip4(ip_addr_t *a, uint32_t v) {
#if LWIP_IPV6
    a->type = IPADDR_TYPE_V4;
    a->u_addr.ip4.addr = v;
#else
    a->addr = v;
#endif
}

/* IPv4 address of a host name (or literal). False: it does not resolve. */
static bool resolve(const char *host, ip_addr_t *out, char *text, size_t cap) {
    struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM};
    struct addrinfo *res = NULL;
    if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) return false;
    struct sockaddr_in *a = (struct sockaddr_in *)res->ai_addr;
    if (out) set_ip4(out, a->sin_addr.s_addr);
    if (text) inet_ntoa_r(a->sin_addr, text, cap);
    freeaddrinfo(res);
    return true;
}

/* A TCP connection within timeout_ms. >= 0: the socket. -1: no such name. -2: no connection. */
static int tcp_open(const char *host, int port, int timeout_ms) {
    struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM};
    struct addrinfo *res = NULL;
    char p[8];
    snprintf(p, sizeof p, "%d", port);
    if (getaddrinfo(host, p, &hints, &res) != 0 || !res) return -1;
    int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd < 0) {
        freeaddrinfo(res);
        return -2;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
    int r = connect(fd, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);
    if (r != 0 && errno != EINPROGRESS) {
        close(fd);
        return -2;
    }
    if (r != 0) {
        fd_set w;
        FD_ZERO(&w);
        FD_SET(fd, &w);
        struct timeval tv = {.tv_sec = timeout_ms / 1000, .tv_usec = (timeout_ms % 1000) * 1000};
        int err = 0;
        socklen_t len = sizeof err;
        if (select(fd + 1, NULL, &w, NULL, &tv) <= 0 || getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
            close(fd);
            return -2;
        }
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) & ~O_NONBLOCK);
    return fd;
}

/* One round of net.watch. Without an address, nothing is checked: UNKNOWN. */
static void watch_once(void) {
    char dns[254], up[254];
    xSemaphoreTake(watch_mutex, portMAX_DELAY);
    memcpy(dns, watch.dns, sizeof dns);
    memcpy(up, watch.upstream, sizeof up);
    xSemaphoreGive(watch_mutex);

    hdp_check_t gw = HDP_CHECK_UNKNOWN, dn = HDP_CHECK_UNKNOWN, inet = HDP_CHECK_UNKNOWN;
    int32_t latency = -1;
    float loss = -1;
    esp_netif_ip_info_t ip;
    if (netif && esp_netif_get_ip_info(netif, &ip) == ESP_OK && ip.gw.addr != 0) {
        ip_addr_t to;
        set_ip4(&to, ip.gw.addr);
        uint32_t sent = 0, replies = 0, avg = 0;
        if (ping(&to, 4, &sent, &replies, &avg)) {
            gw = replies ? HDP_CHECK_PASS : HDP_CHECK_FAIL;
            loss = sent ? 100.0f * (float)(sent - replies) / (float)sent : -1;
            latency = replies ? (int32_t)avg : -1;
        }
        if (dns[0]) dn = resolve(dns, NULL, NULL, 0) ? HDP_CHECK_PASS : HDP_CHECK_FAIL;
        if (up[0]) {
            int fd = tcp_open(up, 443, 3000);
            if (fd >= 0) close(fd);
            /* A name that does not resolve is a DNS answer, not an upstream one. */
            inet = fd >= 0 ? HDP_CHECK_PASS : fd == -2 ? HDP_CHECK_FAIL : HDP_CHECK_UNKNOWN;
        }
    }
    portENTER_CRITICAL(&lock);
    state.gateway_status = gw;
    state.dns_status = dn;
    state.internet = inet;
    state.latency_ms = latency;
    state.loss_pct = loss;
    portEXIT_CRITICAL(&lock);
    changed = true;
}

static void watch_loop(void *arg) {
    (void)arg;
    for (;;) {
        xSemaphoreTake(watch_mutex, portMAX_DELAY);
        uint32_t every = watch.every_ms;
        xSemaphoreGive(watch_mutex);
        if (every == 0) {
            ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
            continue;
        }
        watch_once();
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(every));
    }
}

int hwnet_watch(void *ctx, uint32_t every_ms, const char *dns, const char *upstream) {
    (void)ctx;
    if (!watch_task) return -1;
    xSemaphoreTake(watch_mutex, portMAX_DELAY);
    watch.every_ms = every_ms;
    snprintf(watch.dns, sizeof watch.dns, "%s", dns ? dns : "");
    snprintf(watch.upstream, sizeof watch.upstream, "%s", upstream ? upstream : "");
    xSemaphoreGive(watch_mutex);
    if (every_ms == 0) {
        portENTER_CRITICAL(&lock);
        forget_checks();
        portEXIT_CRITICAL(&lock);
        changed = true;
    }
    xTaskNotifyGive(watch_task);
    return 0;
}

/* ------------------------------------------------------------ probes */

static void post(const char *id, const char *test, hdp_check_t status, const char *detail) {
    result_t r = {.done = false, .status = status};
    snprintf(r.id, sizeof r.id, "%s", id);
    snprintf(r.test, sizeof r.test, "%s", test);
    snprintf(r.detail, sizeof r.detail, "%s", detail);
    xQueueSend(results, &r, portMAX_DELAY);
}

static void run_test(const job_t *j, const char *test) {
    char detail[96], ip[16];
    if (!strcmp(test, "PING")) {
        ip_addr_t to;
        uint32_t sent = 0, replies = 0, avg = 0;
        if (!resolve(j->target, &to, ip, sizeof ip)) {
            post(j->id, test, HDP_CHECK_FAIL, "name does not resolve");
        } else if (!ping(&to, 4, &sent, &replies, &avg)) {
            post(j->id, test, HDP_CHECK_UNKNOWN, "ping could not run");
        } else {
            snprintf(detail, sizeof detail, "%lu/%lu replies from %s, avg %lu ms", (unsigned long)replies, (unsigned long)sent, ip, (unsigned long)avg);
            post(j->id, test, replies == sent ? HDP_CHECK_PASS : replies ? HDP_CHECK_WARN : HDP_CHECK_FAIL, detail);
        }
        return;
    }
    if (!strcmp(test, "DNS")) {
        struct in_addr literal;
        if (inet_aton(j->target, &literal)) {
            post(j->id, test, HDP_CHECK_UNKNOWN, "the target is an address: nothing to resolve");
        } else if (!resolve(j->target, NULL, ip, sizeof ip)) {
            post(j->id, test, HDP_CHECK_FAIL, "does not resolve");
        } else {
            snprintf(detail, sizeof detail, "resolved to %s", ip);
            post(j->id, test, HDP_CHECK_PASS, detail);
        }
        return;
    }
    int fd = tcp_open(j->target, 80, 3000);
    if (fd == -1) {
        post(j->id, test, HDP_CHECK_FAIL, "name does not resolve");
        return;
    }
    if (fd < 0) {
        post(j->id, test, HDP_CHECK_FAIL, "port 80: no answer or refused");
        return;
    }
    if (!strcmp(test, "TCP")) {
        close(fd);
        post(j->id, test, HDP_CHECK_PASS, "port 80 open");
        return;
    }
    /* HTTP: one request, the status line of the answer. */
    struct timeval tv = {.tv_sec = 3, .tv_usec = 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    char req[320];
    int n = snprintf(req, sizeof req, "GET / HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n", j->target);
    char line[64] = {0};
    if (send(fd, req, (size_t)n, 0) == n) {
        int got = recv(fd, line, sizeof line - 1, 0);
        if (got > 0) line[got] = '\0';
    }
    close(fd);
    char *eol = strpbrk(line, "\r\n");
    if (eol) *eol = '\0';
    if (strncmp(line, "HTTP/", 5) != 0) post(j->id, test, HDP_CHECK_FAIL, "no HTTP answer on port 80");
    else post(j->id, test, HDP_CHECK_PASS, line);
}

static void probe_loop(void *arg) {
    (void)arg;
    static job_t j;
    for (;;) {
        if (xQueueReceive(jobs, &j, portMAX_DELAY) != pdTRUE) continue;
        for (int k = 0; k < j.n; k++) run_test(&j, j.tests[k]);
        result_t done = {.done = true};
        snprintf(done.id, sizeof done.id, "%s", j.id);
        xQueueSend(results, &done, portMAX_DELAY);
    }
}

int hwnet_probe_start(void *ctx, const char *id, const char *target, const char (*tests)[16], int n) {
    (void)ctx;
    if (!jobs) return -1;
    static job_t j;
    memset(&j, 0, sizeof j);
    snprintf(j.id, sizeof j.id, "%s", id);
    snprintf(j.target, sizeof j.target, "%s", target);
    j.n = n < 8 ? n : 8;
    for (int k = 0; k < j.n; k++) snprintf(j.tests[k], sizeof j.tests[k], "%s", tests[k]);
    return xQueueSend(jobs, &j, 0) == pdTRUE ? 0 : -1;
}

void hwnet_drain_probes(hdp_device_t *d) {
    static result_t r;
    while (results && xQueueReceive(results, &r, 0) == pdTRUE) {
        if (r.done) hdp_probe_done(d, r.id);
        else hdp_probe_result(d, r.id, r.test, r.status, r.detail);
    }
}

/* ------------------------------------------------------------ start */

bool hwnet_start(void) {
    bool wifi = strlen(CONFIG_HWDOG_WIFI_SSID) > 0;
    bool eth = false;
#if CONFIG_HWDOG_ETH_W5500
    eth = true;
#endif
    if (!wifi && !eth) return false; /* no network: net.status link is null */
    esp_netif_init();
    esp_event_loop_create_default();
    state = (hdp_net_t){.link_present = true, .link_up = false, .dhcp = HDP_CHECK_PENDING};
    forget_checks();
    bool up = false;
#if CONFIG_HWDOG_ETH_W5500
    up = eth_start(); /* the wired port wins: it is the port LVL 80 watches */
#endif
    if (!up && wifi) up = wifi_start();
    if (!up) return false;
    watch_mutex = xSemaphoreCreateMutex();
    jobs = xQueueCreate(2, sizeof(job_t));
    results = xQueueCreate(16, sizeof(result_t));
    xTaskCreate(watch_loop, "hwdog_watch", 6144, NULL, 4, &watch_task);
    xTaskCreate(probe_loop, "hwdog_probe", 6144, NULL, 4, NULL);
    return true;
}
