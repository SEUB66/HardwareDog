/*
 * HARDWARE DOG / FIRMWARE CORE — HDP v1 device side.
 * See hdp.h. Strict in what it sends, liberal in what it accepts.
 */
#include "hdp/hdp.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------ INA226 */

#define INA_REG_CONFIG 0x00
#define INA_REG_BUS 0x02
#define INA_REG_CURRENT 0x04
#define INA_REG_CAL 0x05
#define INA_REG_MANUFACTURER 0xFE
#define INA_REG_DIE 0xFF
#define INA_MANUFACTURER_TI 0x5449
#define INA_DIE_226 0x226 /* upper 12 bits of the die id */
#define INA_BUS_LSB_V 0.00125f

uint16_t hdp_ina226_config_word(void) {
    /* bit 14 reserved (1), AVG=4 (001), VBUSCT=1.1 ms (100), VSHCT=1.1 ms (100),
       MODE=shunt+bus continuous (111): a fresh sample every ~8.8 ms. */
    return (uint16_t)(0x4000 | (1u << 9) | (4u << 6) | (4u << 3) | 7u);
}

uint16_t hdp_ina226_calibration(float shunt_ohm, float max_current_a, float *current_lsb) {
    float lsb = max_current_a / 32768.0f;
    float cal = 0.00512f / (lsb * shunt_ohm);
    if (cal > 65535.0f) cal = 65535.0f;
    if (cal < 1.0f) cal = 1.0f;
    uint16_t c = (uint16_t)cal;
    /* The LSB the chip will actually use, after truncation. */
    if (current_lsb) *current_lsb = 0.00512f / ((float)c * shunt_ohm);
    return c;
}

/* ------------------------------------------------------------ output */

typedef struct {
    char buf[HDP_MAX_LINE + 2];
    size_t len;
    bool overflow;
} line_t;

static void put(line_t *l, const char *s, size_t n) {
    if (l->overflow || l->len + n > HDP_MAX_LINE) {
        l->overflow = true;
        return;
    }
    memcpy(l->buf + l->len, s, n);
    l->len += n;
}

static void puts_(line_t *l, const char *s) { put(l, s, strlen(s)); }

static void putf(line_t *l, const char *fmt, ...) {
    char tmp[128];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= sizeof tmp) {
        l->overflow = true;
        return;
    }
    put(l, tmp, (size_t)n);
}

/* Length of a valid UTF-8 sequence starting at s (RFC 3629), 0 if invalid. */
static size_t utf8_valid(const unsigned char *s, size_t avail) {
    unsigned char c = s[0];
    size_t n;
    unsigned char lo = 0x80, hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) n = 2;
    else if (c >= 0xE0 && c <= 0xEF) {
        n = 3;
        if (c == 0xE0) lo = 0xA0;
        if (c == 0xED) hi = 0x9F; /* no surrogates */
    } else if (c >= 0xF0 && c <= 0xF4) {
        n = 4;
        if (c == 0xF0) lo = 0x90;
        if (c == 0xF4) hi = 0x8F;
    } else
        return 0;
    if (avail < n) return 0;
    if (s[1] < lo || s[1] > hi) return 0;
    for (size_t i = 2; i < n; i++)
        if (s[i] < 0x80 || s[i] > 0xBF) return 0;
    return n;
}

size_t hdp_json_string(char *out, size_t cap, const char *str, size_t len) {
    const unsigned char *s = (const unsigned char *)str;
    size_t o = 0;
#define EMIT(ch)                       \
    do {                               \
        if (o + 1 >= cap) return 0;    \
        out[o++] = (char)(ch);         \
    } while (0)
    EMIT('"');
    for (size_t i = 0; i < len;) {
        unsigned char c = s[i];
        if (c < 0x80) {
            const char *esc = NULL;
            char hex[8];
            switch (c) {
            case '"': esc = "\\\""; break;
            case '\\': esc = "\\\\"; break;
            case '\n': esc = "\\n"; break;
            case '\r': esc = "\\r"; break;
            case '\t': esc = "\\t"; break;
            default:
                if (c < 0x20) {
                    snprintf(hex, sizeof hex, "\\u%04x", c);
                    esc = hex;
                }
            }
            if (esc)
                for (const char *e = esc; *e; e++) EMIT(*e);
            else
                EMIT(c);
            i++;
            continue;
        }
        size_t n = utf8_valid(s + i, len - i);
        if (n == 0) {
            /* A byte that is not text: say so, never invent a character. */
            for (const char *e = "\\ufffd"; *e; e++) EMIT(*e);
            i++;
        } else {
            for (size_t k = 0; k < n; k++) EMIT(s[i + k]);
            i += n;
        }
    }
    EMIT('"');
#undef EMIT
    out[o] = '\0';
    return o;
}

static void put_str(line_t *l, const char *s, size_t n) {
    char tmp[HDP_MAX_LINE];
    size_t w = hdp_json_string(tmp, sizeof tmp, s, n);
    if (w == 0) {
        l->overflow = true;
        return;
    }
    put(l, tmp, w);
}

static void put_cstr(line_t *l, const char *s) { put_str(l, s, strlen(s)); }

static void put_opt(line_t *l, const char *s) {
    if (s && *s) put_cstr(l, s);
    else puts_(l, "null");
}

static uint32_t now(hdp_device_t *d) {
    uint32_t t = d->hal.now_ms(d->hal.ctx);
    if (t < d->last_t) t = d->last_t; /* HDP rule 2: t never goes backwards */
    d->last_t = t;
    return t;
}

static void begin(hdp_device_t *d, line_t *l, const char *type) {
    l->len = 0;
    l->overflow = false;
    puts_(l, "{\"type\":\"");
    puts_(l, type);
    putf(l, "\",\"t\":%lu", (unsigned long)now(d));
}

static void send(hdp_device_t *d, line_t *l) {
    puts_(l, "}");
    if (l->overflow) return; /* never send a truncated frame */
    l->buf[l->len++] = '\n';
    d->hal.write(d->hal.ctx, l->buf, l->len);
}

static void send_log(hdp_device_t *d, const char *level, const char *message) {
    line_t l;
    begin(d, &l, "log");
    puts_(&l, ",\"level\":\"");
    puts_(&l, level);
    puts_(&l, "\",\"message\":");
    put_cstr(&l, message);
    send(d, &l);
}

static const char *check_name(hdp_check_t c) {
    switch (c) {
    case HDP_CHECK_PASS: return "PASS";
    case HDP_CHECK_WARN: return "WARN";
    case HDP_CHECK_FAIL: return "FAIL";
    case HDP_CHECK_PENDING: return "PENDING";
    default: return "UNKNOWN";
    }
}

static void send_hello(hdp_device_t *d) {
    line_t l;
    begin(d, &l, "hello");
    putf(&l, ",\"proto\":%d,\"device\":", HDP_PROTO);
    put_cstr(&l, d->cfg.device);
    puts_(&l, ",\"rev\":");
    put_cstr(&l, d->cfg.rev);
    puts_(&l, ",\"fw\":");
    put_cstr(&l, d->cfg.fw);
    /* Declare what is observed: silence about the rest is not an observation. */
    static const char *const names[] = {"power", "usb", "uart", "i2c", "net", "probe"};
    puts_(&l, ",\"caps\":[");
    bool first = true;
    for (int k = 0; k < 6; k++) {
        if (!(d->cfg.caps & (1u << k))) continue;
        putf(&l, "%s\"%s\"", first ? "" : ",", names[k]);
        first = false;
    }
    puts_(&l, "]");
    send(d, &l);
}

static void send_uart_config(hdp_device_t *d) {
    line_t l;
    begin(d, &l, "uart.config");
    putf(&l, ",\"port\":\"UART1\",\"baud\":%lu,\"bits\":8,\"parity\":\"NONE\",\"stop\":1", (unsigned long)d->baud);
    send(d, &l);
}

static void send_net(hdp_device_t *d) {
    hdp_net_t n;
    memset(&n, 0, sizeof n);
    n.dhcp = HDP_CHECK_UNKNOWN;
    if (d->hal.net_status) d->hal.net_status(d->hal.ctx, &n);
    line_t l;
    begin(d, &l, "net.status");
    if (!n.link_present) puts_(&l, ",\"link\":null");
    else putf(&l, ",\"link\":{\"up\":%s,\"mbps\":null,\"duplex\":null}", n.link_up ? "true" : "false");
    puts_(&l, ",\"address\":");
    put_opt(&l, n.address);
    puts_(&l, ",\"dhcp\":\"");
    puts_(&l, check_name(n.dhcp));
    /* Gateway, DNS and Internet are not probed by this firmware yet: UNKNOWN, never guessed. */
    puts_(&l, "\",\"gateway\":{\"address\":");
    put_opt(&l, n.gateway);
    puts_(&l, ",\"status\":\"UNKNOWN\"},\"dns\":{\"address\":");
    put_opt(&l, n.dns);
    puts_(&l, ",\"status\":\"UNKNOWN\"},\"internet\":\"UNKNOWN\",\"latency\":null,\"loss\":null");
    send(d, &l);
}

/* ------------------------------------------------------------ power */

/* Worst case from the INA226 datasheet (SBOS547): bus gain error 0.1 %,
   bus offset 7.5 mV, shunt gain error 0.1 %, shunt offset 10 uV; plus one
   LSB of quantization and the shunt resistor tolerance, which dominates
   the current error until the board is calibrated. */
#define INA_V_MAX 36.0f
#define INA_SHUNT_FS_V 0.08192f
#define INA_GAIN_ERR_PCT 0.1f
#define INA_BUS_OFFSET_V 0.0075f
#define INA_SHUNT_OFFSET_V 0.00001f

static void send_meter(hdp_device_t *d) {
    if (!d->ina_ok) return;
    float shunt = d->cfg.shunt_ohm;
    float i_max = INA_SHUNT_FS_V / shunt;
    if (d->cfg.max_current_a < i_max) i_max = d->cfg.max_current_a;
    line_t l;
    begin(d, &l, "power.meter");
    puts_(&l, ",\"sensor\":\"INA226\"");
    putf(&l, ",\"shunt_ohm\":%.6g,\"v_max\":%.6g,\"i_max\":%.6g", (double)shunt, (double)INA_V_MAX, (double)i_max);
    putf(&l, ",\"v_res\":%.6g,\"i_res\":%.6g", (double)INA_BUS_LSB_V, (double)d->current_lsb);
    putf(&l, ",\"rate_hz\":%.6g", 1000.0 / (double)d->cfg.sample_ms);
    const hdp_cal_t *c = &d->cal;
    if (c->valid) {
        /* Measured against the reference: the residual, plus one LSB. */
        putf(&l, ",\"v_err\":{\"pct\":0,\"abs\":%.6g}", (double)(c->v_err + INA_BUS_LSB_V));
        putf(&l, ",\"i_err\":{\"pct\":0,\"abs\":%.6g}", (double)(c->i_err + d->current_lsb));
        puts_(&l, ",\"basis\":\"CALIBRATION\",\"cal\":{\"date\":");
        put_cstr(&l, c->date);
        puts_(&l, ",\"ref\":");
        put_cstr(&l, c->ref);
        putf(&l, ",\"v_gain\":%.7g,\"i_gain\":%.7g,\"i_offset\":%.7g}", (double)c->v_gain, (double)c->i_gain, (double)c->i_offset);
    } else {
        putf(&l, ",\"v_err\":{\"pct\":%.6g,\"abs\":%.6g}", (double)INA_GAIN_ERR_PCT, (double)(INA_BUS_OFFSET_V + INA_BUS_LSB_V));
        putf(&l, ",\"i_err\":{\"pct\":%.6g,\"abs\":%.6g}", (double)(INA_GAIN_ERR_PCT + d->cfg.shunt_tol_pct),
             (double)(INA_SHUNT_OFFSET_V / shunt + d->current_lsb));
        puts_(&l, ",\"basis\":\"DATASHEET\",\"cal\":null");
    }
    send(d, &l);
}

static void ina_start(hdp_device_t *d) {
    uint16_t man = 0, die = 0;
    uint8_t a = d->cfg.ina_addr;
    char msg[160];
    if (d->hal.ina_read(d->hal.ctx, a, INA_REG_MANUFACTURER, &man) != 0 || d->hal.ina_read(d->hal.ctx, a, INA_REG_DIE, &die) != 0) {
        snprintf(msg, sizeof msg, "INA226 not answering at 0x%02X: power monitor offline", a);
        send_log(d, "error", msg);
        return;
    }
    if (man != INA_MANUFACTURER_TI || (die >> 4) != INA_DIE_226) {
        snprintf(msg, sizeof msg, "device at 0x%02X is not an INA226 (manufacturer 0x%04X, die 0x%04X): power monitor offline", a, man, die);
        send_log(d, "error", msg);
        return;
    }
    uint16_t cal = hdp_ina226_calibration(d->cfg.shunt_ohm, d->cfg.max_current_a, &d->current_lsb);
    if (d->hal.ina_write(d->hal.ctx, a, INA_REG_CONFIG, hdp_ina226_config_word()) != 0 ||
        d->hal.ina_write(d->hal.ctx, a, INA_REG_CAL, cal) != 0) {
        send_log(d, "error", "INA226 configuration failed: power monitor offline");
        return;
    }
    d->ina_ok = true;
    snprintf(msg, sizeof msg, "INA226 at 0x%02X verified (manufacturer 0x5449, die 0x%04X), shunt %.3f ohm, current LSB %.1f uA", a, die,
             (double)d->cfg.shunt_ohm, (double)(d->current_lsb * 1e6f));
    send_log(d, "info", msg);
    if (d->hal.cal_load && d->hal.cal_load(d->hal.ctx, &d->cal) != 0) memset(&d->cal, 0, sizeof d->cal);
    send_meter(d);
}

static void sample_power(hdp_device_t *d) {
    uint16_t bus = 0, cur = 0;
    uint8_t a = d->cfg.ina_addr;
    if (d->hal.ina_read(d->hal.ctx, a, INA_REG_BUS, &bus) != 0 || d->hal.ina_read(d->hal.ctx, a, INA_REG_CURRENT, &cur) != 0) {
        /* A failed read is reported, never replaced by a made-up value. */
        d->ina_ok = false;
        send_log(d, "error", "INA226 read failed: power monitor offline");
        return;
    }
    float v = (float)bus * INA_BUS_LSB_V;
    float i = (float)(int16_t)cur * d->current_lsb;
    if (d->cal.valid) {
        v *= d->cal.v_gain;
        i = i * d->cal.i_gain + d->cal.i_offset;
    }
    line_t l;
    begin(d, &l, "power");
    putf(&l, ",\"v\":%.3f,\"i\":%.4f", (double)v, (double)i);
    send(d, &l);
}

/* ------------------------------------------------------------ target I2C */

static void scan_i2c(hdp_device_t *d) {
    line_t l;
    begin(d, &l, "i2c.scan");
    putf(&l, ",\"speed\":%lu,\"devices\":[", (unsigned long)d->hal.target_i2c_hz);
    bool first = true;
    if (d->hal.target_i2c_probe) {
        for (uint8_t a = 0x08; a <= 0x77; a++) {
            if (d->hal.target_i2c_probe(d->hal.ctx, a) != 0) continue;
            /* No identity: this firmware does not verify one yet (rule 6). */
            putf(&l, "%s{\"addr\":%u,\"ident\":null,\"method\":null}", first ? "" : ",", a);
            first = false;
        }
    }
    puts_(&l, "]");
    send(d, &l);
}

/* ------------------------------------------------------------ commands */

#define MAX_KEYS 8
#define MAX_STR 600
#define MAX_ARR 8

typedef enum { V_STR, V_NUM, V_ARR, V_BOOL, V_NULL } vtype_t;

typedef struct {
    char key[24];
    vtype_t type;
    char str[MAX_STR];
    size_t str_len;
    double num;
    char arr[MAX_ARR][16];
    int arr_n;
} kv_t;

typedef struct {
    const char *s;
    size_t n, i;
} cursor_t;

static void ws(cursor_t *c) {
    while (c->i < c->n && (c->s[c->i] == ' ' || c->s[c->i] == '\t' || c->s[c->i] == '\r' || c->s[c->i] == '\n')) c->i++;
}

static int hexval(char ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

static bool read_hex4(cursor_t *c, uint32_t *out) {
    if (c->i + 4 > c->n) return false;
    uint32_t v = 0;
    for (int k = 0; k < 4; k++) {
        int h = hexval(c->s[c->i + k]);
        if (h < 0) return false;
        v = (v << 4) | (uint32_t)h;
    }
    c->i += 4;
    *out = v;
    return true;
}

static bool append_utf8(char *out, size_t cap, size_t *len, uint32_t cp) {
    unsigned char b[4];
    size_t n;
    if (cp < 0x80) { b[0] = (unsigned char)cp; n = 1; }
    else if (cp < 0x800) { b[0] = (unsigned char)(0xC0 | (cp >> 6)); b[1] = (unsigned char)(0x80 | (cp & 0x3F)); n = 2; }
    else if (cp < 0x10000) { b[0] = (unsigned char)(0xE0 | (cp >> 12)); b[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F)); b[2] = (unsigned char)(0x80 | (cp & 0x3F)); n = 3; }
    else { b[0] = (unsigned char)(0xF0 | (cp >> 18)); b[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F)); b[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F)); b[3] = (unsigned char)(0x80 | (cp & 0x3F)); n = 4; }
    if (*len + n >= cap) return false;
    memcpy(out + *len, b, n);
    *len += n;
    return true;
}

/* A JSON string into out (NUL-terminated). */
static bool parse_string(cursor_t *c, char *out, size_t cap, size_t *len_out) {
    if (c->i >= c->n || c->s[c->i] != '"') return false;
    c->i++;
    size_t len = 0;
    while (c->i < c->n) {
        char ch = c->s[c->i++];
        if (ch == '"') {
            out[len] = '\0';
            if (len_out) *len_out = len;
            return true;
        }
        if ((unsigned char)ch < 0x20) return false;
        if (ch != '\\') {
            if (len + 1 >= cap) return false;
            out[len++] = ch;
            continue;
        }
        if (c->i >= c->n) return false;
        char e = c->s[c->i++];
        uint32_t cp;
        switch (e) {
        case '"': cp = '"'; break;
        case '\\': cp = '\\'; break;
        case '/': cp = '/'; break;
        case 'b': cp = '\b'; break;
        case 'f': cp = '\f'; break;
        case 'n': cp = '\n'; break;
        case 'r': cp = '\r'; break;
        case 't': cp = '\t'; break;
        case 'u':
            if (!read_hex4(c, &cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF) {
                uint32_t lo;
                if (c->i + 2 <= c->n && c->s[c->i] == '\\' && c->s[c->i + 1] == 'u') {
                    c->i += 2;
                    if (!read_hex4(c, &lo)) return false;
                    cp = (lo >= 0xDC00 && lo <= 0xDFFF) ? 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00) : 0xFFFD;
                } else
                    cp = 0xFFFD;
            } else if (cp >= 0xDC00 && cp <= 0xDFFF)
                cp = 0xFFFD;
            break;
        default: return false;
        }
        if (!append_utf8(out, cap, &len, cp)) return false;
    }
    return false;
}

static bool parse_value(cursor_t *c, kv_t *kv) {
    ws(c);
    if (c->i >= c->n) return false;
    char ch = c->s[c->i];
    if (ch == '"') {
        kv->type = V_STR;
        return parse_string(c, kv->str, sizeof kv->str, &kv->str_len);
    }
    if (ch == '[') {
        c->i++;
        kv->type = V_ARR;
        kv->arr_n = 0;
        ws(c);
        if (c->i < c->n && c->s[c->i] == ']') {
            c->i++;
            return true;
        }
        for (;;) {
            ws(c);
            if (kv->arr_n >= MAX_ARR) return false;
            if (!parse_string(c, kv->arr[kv->arr_n], sizeof kv->arr[0], NULL)) return false;
            kv->arr_n++;
            ws(c);
            if (c->i >= c->n) return false;
            if (c->s[c->i] == ',') { c->i++; continue; }
            if (c->s[c->i] == ']') { c->i++; return true; }
            return false;
        }
    }
    if (ch == '-' || (ch >= '0' && ch <= '9')) {
        char num[32];
        size_t k = 0;
        while (c->i < c->n && k < sizeof num - 1 && strchr("+-0123456789.eE", c->s[c->i])) num[k++] = c->s[c->i++];
        num[k] = '\0';
        char *end;
        kv->num = strtod(num, &end);
        kv->type = V_NUM;
        return *end == '\0' && isfinite(kv->num);
    }
    const char *lits[] = {"true", "false", "null"};
    for (int k = 0; k < 3; k++) {
        size_t n = strlen(lits[k]);
        if (c->i + n <= c->n && memcmp(c->s + c->i, lits[k], n) == 0) {
            c->i += n;
            kv->type = k < 2 ? V_BOOL : V_NULL;
            kv->num = k == 0;
            return true;
        }
    }
    return false;
}

/* One flat JSON object. Nested objects are not part of any HDP command. */
static int parse_object(const char *s, size_t n, kv_t *kvs) {
    cursor_t c = {s, n, 0};
    int count = 0;
    ws(&c);
    if (c.i >= c.n || s[c.i] != '{') return -1;
    c.i++;
    ws(&c);
    if (c.i < c.n && s[c.i] == '}') {
        c.i++;
    } else {
        for (;;) {
            if (count >= MAX_KEYS) return -1;
            ws(&c);
            if (!parse_string(&c, kvs[count].key, sizeof kvs[count].key, NULL)) return -1;
            ws(&c);
            if (c.i >= c.n || s[c.i] != ':') return -1;
            c.i++;
            if (!parse_value(&c, &kvs[count])) return -1;
            count++;
            ws(&c);
            if (c.i >= c.n) return -1;
            if (s[c.i] == ',') { c.i++; continue; }
            if (s[c.i] == '}') { c.i++; break; }
            return -1;
        }
    }
    ws(&c);
    return c.i == c.n ? count : -1;
}

static const kv_t *field(const kv_t *kvs, int n, const char *key, vtype_t type) {
    for (int k = 0; k < n; k++)
        if (strcmp(kvs[k].key, key) == 0 && kvs[k].type == type) return &kvs[k];
    return NULL;
}

static void reject(hdp_device_t *d, const char *why) {
    char msg[200];
    snprintf(msg, sizeof msg, "command rejected: %s", why);
    send_log(d, "warn", msg);
}

static void probe(hdp_device_t *d, const kv_t *id, const kv_t *tests) {
    /* Network probes are not implemented on this firmware yet: say so per test. */
    for (int k = 0; tests && k < tests->arr_n; k++) {
        line_t l;
        begin(d, &l, "probe.result");
        puts_(&l, ",\"id\":");
        put_str(&l, id->str, id->str_len);
        puts_(&l, ",\"test\":");
        const char *t = tests->arr[k];
        if (strcmp(t, "PING") && strcmp(t, "DNS") && strcmp(t, "TCP") && strcmp(t, "HTTP")) {
            reject(d, "unknown probe test");
            continue;
        }
        put_cstr(&l, t);
        puts_(&l, ",\"status\":\"UNKNOWN\",\"detail\":\"not available on this firmware\"");
        send(d, &l);
    }
    line_t l;
    begin(d, &l, "probe.done");
    puts_(&l, ",\"id\":");
    put_str(&l, id->str, id->str_len);
    send(d, &l);
}

static bool is_date(const char *s) {
    if (strlen(s) != 10 || s[4] != '-' || s[7] != '-') return false;
    for (int k = 0; k < 10; k++)
        if (k != 4 && k != 7 && (s[k] < '0' || s[k] > '9')) return false;
    return true;
}

/* Store a calibration. Checked like the schema: a bad one changes nothing. */
static void meter_cal(hdp_device_t *d, const kv_t *kvs, int n) {
    const kv_t *date = field(kvs, n, "date", V_STR), *ref = field(kvs, n, "ref", V_STR);
    const kv_t *vg = field(kvs, n, "v_gain", V_NUM), *ig = field(kvs, n, "i_gain", V_NUM), *io = field(kvs, n, "i_offset", V_NUM);
    const kv_t *ve = field(kvs, n, "v_err", V_NUM), *ie = field(kvs, n, "i_err", V_NUM);
    if (!d->ina_ok) {
        reject(d, "meter.cal: no verified power sensor");
        return;
    }
    if (!date || !ref || !vg || !ig || !io || !ve || !ie) {
        reject(d, "meter.cal needs date, ref, v_gain, i_gain, i_offset, v_err, i_err");
        return;
    }
    if (!is_date(date->str) || ref->str_len == 0 || ref->str_len > 64 || vg->num < 0.9 || vg->num > 1.1 || ig->num < 0.9 || ig->num > 1.1 ||
        fabs(io->num) > 0.05 || ve->num < 0 || ie->num < 0) {
        reject(d, "meter.cal: value out of range, calibration unchanged");
        return;
    }
    hdp_cal_t c;
    memset(&c, 0, sizeof c);
    c.valid = true;
    memcpy(c.date, date->str, 10);
    memcpy(c.ref, ref->str, ref->str_len);
    c.v_gain = (float)vg->num;
    c.i_gain = (float)ig->num;
    c.i_offset = (float)io->num;
    c.v_err = (float)ve->num;
    c.i_err = (float)ie->num;
    d->cal = c;
    if (d->hal.cal_save && d->hal.cal_save(d->hal.ctx, &c) == 0) send_log(d, "info", "calibration stored");
    else send_log(d, "warn", "calibration applied but not stored: lost at reboot");
    send_meter(d);
}

static void handle_command(hdp_device_t *d, const char *line, size_t len) {
    static kv_t kvs[MAX_KEYS]; /* large: not on the stack */
    memset(kvs, 0, sizeof kvs);
    int n = parse_object(line, len, kvs);
    if (n < 0) {
        reject(d, "not a JSON object");
        return;
    }
    const kv_t *cmd = field(kvs, n, "cmd", V_STR);
    if (!cmd) {
        reject(d, "no \"cmd\"");
        return;
    }
    const char *c = cmd->str;
    if (!strcmp(c, "hello")) {
        send_hello(d);
        send_uart_config(d);
        send_net(d);
        send_meter(d);
    } else if (!strcmp(c, "uart.config")) {
        const kv_t *b = field(kvs, n, "baud", V_NUM);
        if (!b || b->num < 300 || b->num > 4000000 || b->num != floor(b->num)) {
            reject(d, "uart.config needs an integer baud 300..4000000");
            return;
        }
        if (d->hal.uart_set_baud(d->hal.ctx, (uint32_t)b->num) != 0) {
            send_log(d, "error", "uart.config: the UART refused this baud rate");
            return;
        }
        d->baud = (uint32_t)b->num;
        d->uart_len = 0;
        send_uart_config(d);
    } else if (!strcmp(c, "uart.tx")) {
        const kv_t *data = field(kvs, n, "data", V_STR);
        if (!data) {
            reject(d, "uart.tx needs \"data\"");
            return;
        }
        d->hal.uart_write(d->hal.ctx, data->str, data->str_len);
        d->hal.uart_write(d->hal.ctx, "\r\n", 2);
    } else if (!strcmp(c, "i2c.scan")) {
        scan_i2c(d);
    } else if (!strcmp(c, "net.refresh")) {
        send_net(d);
    } else if (!strcmp(c, "meter.cal")) {
        meter_cal(d, kvs, n);
    } else if (!strcmp(c, "meter.clear")) {
        if (!d->ina_ok) {
            reject(d, "meter.clear: no verified power sensor");
            return;
        }
        memset(&d->cal, 0, sizeof d->cal);
        if (d->hal.cal_save) d->hal.cal_save(d->hal.ctx, &d->cal);
        send_log(d, "info", "calibration removed: datasheet accuracy");
        send_meter(d);
    } else if (!strcmp(c, "usb.enumerate")) {
        send_log(d, "warn", "usb.enumerate: this hardware revision has no USB host port");
    } else if (!strcmp(c, "probe")) {
        const kv_t *id = field(kvs, n, "id", V_STR);
        const kv_t *tests = field(kvs, n, "tests", V_ARR);
        if (!id || !tests || !field(kvs, n, "target", V_STR)) {
            reject(d, "probe needs id, target and tests");
            return;
        }
        probe(d, id, tests);
    } else {
        reject(d, "unknown cmd");
    }
}

/* ------------------------------------------------------------ public */

void hdp_init(hdp_device_t *d, const hdp_config_t *cfg, const hdp_hal_t *hal) {
    memset(d, 0, sizeof *d);
    d->cfg = *cfg;
    d->hal = *hal;
    d->baud = 115200;
}

void hdp_start(hdp_device_t *d) {
    send_hello(d);
    send_uart_config(d);
    send_net(d);
    ina_start(d);
    uint32_t t = now(d);
    d->next_sample = t;
    d->next_net = d->cfg.net_ms ? t + d->cfg.net_ms : 0;
}

void hdp_host_input(hdp_device_t *d, const char *data, size_t len) {
    for (size_t k = 0; k < len; k++) {
        char ch = data[k];
        if (ch == '\n') {
            size_t n = d->cmd_len;
            if (n > 0 && d->cmd[n - 1] == '\r') n--;
            if (d->cmd_overflow) reject(d, "longer than 1024 bytes");
            else if (n > 0) handle_command(d, d->cmd, n);
            d->cmd_len = 0;
            d->cmd_overflow = false;
        } else if (d->cmd_len < HDP_MAX_COMMAND) {
            d->cmd[d->cmd_len++] = ch;
        } else {
            d->cmd_overflow = true;
        }
    }
}

static void flush_uart_line(hdp_device_t *d) {
    size_t n = d->uart_len;
    if (n > 0 && d->uart_line[n - 1] == '\r') n--;
    line_t l;
    begin(d, &l, "uart.rx");
    puts_(&l, ",\"data\":");
    put_str(&l, d->uart_line, n);
    send(d, &l);
    d->uart_len = 0;
}

void hdp_uart_input(hdp_device_t *d, const char *data, size_t len) {
    for (size_t k = 0; k < len; k++) {
        if (data[k] == '\n') {
            flush_uart_line(d);
            continue;
        }
        d->uart_line[d->uart_len++] = data[k];
        if (d->uart_len == HDP_MAX_UART_LINE) flush_uart_line(d); /* split, never drop */
    }
}

void hdp_uart_error(hdp_device_t *d, const char *kind) {
    line_t l;
    begin(d, &l, "uart.error");
    puts_(&l, ",\"kind\":");
    put_cstr(&l, kind);
    send(d, &l);
}

void hdp_poll(hdp_device_t *d) {
    uint32_t t = now(d);
    if (d->ina_ok && t >= d->next_sample) {
        sample_power(d);
        d->next_sample += d->cfg.sample_ms;
        /* Fell far behind (a long blocking call): resynchronise, do not burst. */
        if (t > d->next_sample + 5 * d->cfg.sample_ms) d->next_sample = t + d->cfg.sample_ms;
    }
    if (d->cfg.net_ms && t >= d->next_net) {
        send_net(d);
        d->next_net = t + d->cfg.net_ms;
    }
}
