idf_component_register(
    SRCS "main.c" "net.c"
    REQUIRES hdp esp_driver_i2c esp_driver_uart esp_driver_usb_serial_jtag esp_driver_gpio esp_driver_spi esp_timer esp_wifi esp_eth esp_netif esp_event lwip nvs_flash
)
