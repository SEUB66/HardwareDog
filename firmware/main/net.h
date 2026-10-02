/*
 * HARDWARE DOG / FIRMWARE, the network side on the ESP32-S3 (LVL 80).
 *
 * The wired port (W5500, SPI) or Wi-Fi station, the periodic network
 * checks asked by net.watch, and the probes, run in their own tasks. The
 * core is only ever called from the main task: results come back through
 * hwnet_status() and hwnet_drain_probes().
 */
#ifndef HWDOG_NET_H
#define HWDOG_NET_H

#include <stdbool.h>
#include <stdint.h>

#include "hdp/hdp.h"

/* Start the configured network (W5500 first, else Wi-Fi). False: none. */
bool hwnet_start(void);
/* True once after the network changed (link, address, a check result). */
bool hwnet_take_changed(void);

/* HAL hooks (hdp_hal_t). */
void hwnet_status(void *ctx, hdp_net_t *out);
int hwnet_watch(void *ctx, uint32_t every_ms, const char *dns, const char *upstream);
int hwnet_probe_start(void *ctx, const char *id, const char *target, const char (*tests)[16], int n);

/* Main task: hand finished probe results to the core. */
void hwnet_drain_probes(hdp_device_t *d);

#endif
