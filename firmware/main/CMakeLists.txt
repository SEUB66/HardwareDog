idf_component_register(
    SRCS "main.c"
    REQUIRES hdp esp_driver_i2c esp_driver_uart esp_driver_usb_serial_jtag esp_timer esp_wifi esp_netif esp_event nvs_flash
)
