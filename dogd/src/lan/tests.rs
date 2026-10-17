use super::*;

const IP_JSON: &str = r#"[
 {"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP","LOWER_UP"],"operstate":"UNKNOWN",
  "addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8}]},
 {"ifindex":2,"ifname":"wlan0","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"operstate":"UP",
  "addr_info":[{"family":"inet","local":"192.168.1.42","prefixlen":24},{"family":"inet6","local":"fe80::1","prefixlen":64}]},
 {"ifindex":3,"ifname":"eth0","flags":["BROADCAST","MULTICAST"],"operstate":"DOWN",
  "addr_info":[{"family":"inet","local":"10.0.0.5","prefixlen":8}]},
 {"ifindex":4,"ifname":"wwan0","flags":["UP"],"operstate":"UP",
  "addr_info":[{"family":"inet","local":"100.72.1.9","prefixlen":30}]},
 {"ifindex":5,"ifname":"weird","addr_info":[{"family":"inet","local":"nope","prefixlen":24},{"family":"inet","local":"10.1.1.1","prefixlen":99}]},
 {"noname":true}
]"#;

#[test]
fn interfaces_are_read_and_judged() {
    let list = parse_ip_addr_json(IP_JSON);
    let names: Vec<&str> = list.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["lo", "wlan0", "eth0", "wwan0"]);
    let by = |n: &str| list.iter().find(|i| i.name == n).unwrap();
    assert_eq!(refuse(by("wlan0")), None);
    assert_eq!(
        by("wlan0").network(),
        "192.168.1.0".parse::<Ipv4Addr>().unwrap()
    );
    assert!(refuse(by("lo")).unwrap().contains("loopback"));
    assert!(refuse(by("eth0")).unwrap().contains("down"));
    // carrier-grade NAT space is not RFC 1918: refused
    assert!(refuse(by("wwan0")).unwrap().contains("private"));
    assert!(parse_ip_addr_json("not json").is_empty());
    assert!(parse_ip_addr_json("{}").is_empty());
}

#[test]
fn a_network_wider_than_a_16_is_refused() {
    let wide = Iface {
        name: "eth0".into(),
        address: "10.2.3.4".parse().unwrap(),
        prefix: 8,
        up: true,
        private: true,
        loopback: false,
    };
    assert!(refuse(&wide).unwrap().contains("/16"));
    assert!(wide.contains("10.200.1.1".parse().unwrap()));
    assert_eq!(mask("10.2.3.4".parse().unwrap(), 0), Ipv4Addr::UNSPECIFIED);
    assert_eq!(
        mask("10.2.3.4".parse().unwrap(), 32),
        "10.2.3.4".parse::<Ipv4Addr>().unwrap()
    );
}

#[test]
fn the_neighbor_table_keeps_complete_entries_with_their_device() {
    let text = "IP address       HW type     Flags       HW address            Mask     Device\n\
                192.168.1.1      0x1         0x2         a4:91:b1:00:11:22     *        wlan0\n\
                192.168.1.77     0x1         0x0         00:00:00:00:00:00     *        wlan0\n\
                192.168.1.80     0x1         0x2         DA:A1:19:00:00:01     *        wlan0\n\
                garbage line\n\
                10.9.9.9 0x1 0x2 zz:zz *\n";
    let n = parse_proc_arp(text);
    assert_eq!(n.len(), 3);
    assert_eq!(n[0].mac.as_deref(), Some("a4:91:b1:00:11:22"));
    assert!(n[0].complete);
    assert_eq!(n[1].mac, None);
    assert!(!n[1].complete);
    assert_eq!(n[2].mac.as_deref(), Some("da:a1:19:00:00:01"));
    assert!(mac_is_local("da:a1:19:00:00:01"));
    assert!(!mac_is_local("a4:91:b1:00:11:22"));
}

#[test]
fn macs_are_normalized_or_refused() {
    assert_eq!(
        normalize_mac("AA-BB-CC-DD-EE-FF").as_deref(),
        Some("aa:bb:cc:dd:ee:ff")
    );
    assert_eq!(
        normalize_mac("aabb.ccdd.eeff").as_deref(),
        Some("aa:bb:cc:dd:ee:ff")
    );
    assert_eq!(normalize_mac("aa:bb:cc:dd:ee"), None);
    assert_eq!(normalize_mac("aa:bb:cc:dd:ee:gg"), None);
}

#[test]
fn the_oui_registry_reads_the_usual_formats_and_never_names_a_random_mac() {
    let ieee = "OUI/MA-L\t\t\tOrganization\n\nAC-DE-48   (hex)\t\tPrivate\nACDE48     (base 16)\t\tPrivate\n\n00-1B-63   (hex)\t\tApple, Inc.\n";
    let oui = Oui::parse(ieee, "/usr/share/ieee-data/oui.txt");
    assert_eq!(oui.lookup("00:1b:63:12:34:56"), Some("Apple, Inc."));
    assert_eq!(oui.lookup("ac:de:48:00:00:01"), Some("Private"));
    let nmap = Oui::parse("# comment\n001B63 Apple\nFCFBFB\tCisco Systems\n", "nmap");
    assert_eq!(nmap.lookup("fc:fb:fb:01:02:03"), Some("Cisco Systems"));
    // locally administered: no registry applies, whatever the prefix
    let local = Oui::parse("02AABB Somebody\n", "x");
    assert_eq!(local.lookup("02:aa:bb:00:00:00"), None);
    assert_eq!(nmap.lookup("12:34:56:78:9a:bc"), None);
}

fn mdns_answer() -> Vec<u8> {
    use simple_dns::rdata::{RData, A, PTR, SRV, TXT};
    use simple_dns::{Name, Packet, ResourceRecord, CLASS};
    let mut p = Packet::new_reply(0);
    p.answers.push(ResourceRecord::new(
        Name::new_unchecked("_services._dns-sd._udp.local"),
        CLASS::IN,
        120,
        RData::PTR(PTR(Name::new_unchecked("_rtsp._tcp.local"))),
    ));
    p.answers.push(ResourceRecord::new(
        Name::new_unchecked("_rtsp._tcp.local"),
        CLASS::IN,
        120,
        RData::PTR(PTR(Name::new_unchecked("Hall._rtsp._tcp.local"))),
    ));
    p.additional_records.push(ResourceRecord::new(
        Name::new_unchecked("Hall._rtsp._tcp.local"),
        CLASS::IN,
        120,
        RData::SRV(SRV {
            priority: 0,
            weight: 0,
            port: 554,
            target: Name::new_unchecked("cam-1.local"),
        }),
    ));
    let txt = TXT::new()
        .with_string("model=X100")
        .unwrap()
        .with_string("fw=1.2")
        .unwrap();
    p.additional_records.push(ResourceRecord::new(
        Name::new_unchecked("Hall._rtsp._tcp.local"),
        CLASS::IN,
        120,
        RData::TXT(txt),
    ));
    p.additional_records.push(ResourceRecord::new(
        Name::new_unchecked("cam-1.local"),
        CLASS::IN,
        120,
        RData::A(A {
            address: u32::from(Ipv4Addr::new(192, 168, 1, 50)),
        }),
    ));
    p.build_bytes_vec_compressed().unwrap()
}

#[test]
fn mdns_answers_give_types_instances_ports_txt_and_addresses() {
    let a = parse_mdns(&mdns_answer()).unwrap();
    assert_eq!(a.service_types, ["_rtsp._tcp.local"]);
    assert_eq!(
        a.instances.get("Hall._rtsp._tcp.local").map(String::as_str),
        Some("_rtsp._tcp.local")
    );
    assert_eq!(
        a.srv.get("Hall._rtsp._tcp.local"),
        Some(&("cam-1.local".to_string(), 554))
    );
    assert_eq!(a.txt["Hall._rtsp._tcp.local"]["model"], "X100");
    assert_eq!(a.a["cam-1.local"], Ipv4Addr::new(192, 168, 1, 50));
}

#[test]
fn mdns_queries_are_built_and_malformed_packets_are_refused() {
    let q = mdns_query(&[SERVICES_ENUM, "_rtsp._tcp.local"]).unwrap();
    let p = simple_dns::Packet::parse(&q).unwrap();
    assert_eq!(p.id(), 0);
    assert_eq!(p.questions.len(), 2);
    // a label over 63 bytes is not a DNS name
    assert!(mdns_query(&[&format!("{}.local", "a".repeat(70))]).is_none());
    let good = mdns_answer();
    // truncated anywhere, random bytes, a compression pointer to itself: never a panic
    for cut in 0..good.len() {
        let _ = parse_mdns(&good[..cut]);
    }
    assert!(parse_mdns(&[0u8; 3]).is_none());
    let mut loop_ptr = vec![0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0];
    loop_ptr.extend_from_slice(&[0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 1, 0, 2, 0xc0, 12]);
    assert!(parse_mdns(&loop_ptr).is_none_or(|a| a.instances.is_empty()));
}

#[test]
fn ssdp_answers_and_locations() {
    let text = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.1.60:49152/desc.xml\r\nSERVER: Linux/4.9 UPnP/1.0 IPCam/1.0\r\nST: upnp:rootdevice\r\nUSN: uuid:abc::upnp:rootdevice\r\n\r\n";
    let a = parse_ssdp(text).unwrap();
    assert_eq!(
        a.location.as_deref(),
        Some("http://192.168.1.60:49152/desc.xml")
    );
    assert_eq!(a.server.as_deref(), Some("Linux/4.9 UPnP/1.0 IPCam/1.0"));
    assert_eq!(a.st.as_deref(), Some("upnp:rootdevice"));
    assert_eq!(
        split_http_url("http://192.168.1.60:49152/desc.xml"),
        Some(("192.168.1.60".parse().unwrap(), 49152, "/desc.xml".into()))
    );
    assert_eq!(
        split_http_url("http://192.168.1.60/x"),
        Some(("192.168.1.60".parse().unwrap(), 80, "/x".into()))
    );
    assert_eq!(split_http_url("http://printer.local/x"), None);
    assert_eq!(split_http_url("ftp://192.168.1.1/"), None);
    assert!(parse_ssdp("HTTP/1.1 404 Not Found\r\n\r\n").is_none());
    assert!(parse_ssdp("").is_none());
}

#[test]
fn upnp_descriptions_name_the_device_in_its_own_words() {
    let xml = r#"<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major></specVersion>
      <device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Living room TV</friendlyName>
      <manufacturer>ACME</manufacturer><modelName>TV-55</modelName><deviceList><device><friendlyName>inner</friendlyName></device></deviceList></device></root>"#;
    let d = parse_upnp_description(xml).unwrap();
    assert_eq!(
        d.device_type.as_deref(),
        Some("urn:schemas-upnp-org:device:MediaRenderer:1")
    );
    assert_eq!(d.friendly_name.as_deref(), Some("Living room TV"));
    assert_eq!(d.manufacturer.as_deref(), Some("ACME"));
    assert_eq!(d.model_name.as_deref(), Some("TV-55"));
    assert!(parse_upnp_description("<root><unclosed>").is_none());
    assert!(parse_upnp_description("<root/>").is_none());
}

#[test]
fn ws_discovery_probe_matches_are_read_with_their_scopes() {
    let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch>
<wsa:EndpointReference><wsa:Address>urn:uuid:1234</wsa:Address></wsa:EndpointReference>
<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/Front%20Door onvif://www.onvif.org/hardware/NVR-8 onvif://www.onvif.org/location/</d:Scopes>
<d:XAddrs>http://192.168.1.70/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs>
<d:MetadataVersion>1</d:MetadataVersion></d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>"#;
    let m = parse_wsd(xml);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].types, ["dn:NetworkVideoTransmitter", "tds:Device"]);
    assert_eq!(m[0].name.as_deref(), Some("Front Door"));
    assert_eq!(m[0].hardware.as_deref(), Some("NVR-8"));
    assert_eq!(m[0].endpoint.as_deref(), Some("urn:uuid:1234"));
    assert_eq!(
        xaddr_host(&m[0].xaddrs[0]),
        Some("192.168.1.70".parse().unwrap())
    );
    assert_eq!(xaddr_host(&m[0].xaddrs[1]), None);
    assert!(parse_wsd("<not xml").is_empty());
    assert!(parse_wsd("<a><b/></a>").is_empty());
    let probe = wsd_probe("u-1", "dn:NetworkVideoTransmitter");
    assert!(roxmltree::Document::parse(&probe).is_ok());
    assert!(probe.contains("<d:Types>dn:NetworkVideoTransmitter</d:Types>"));
}

#[test]
fn percent_decoding_survives_bad_input() {
    assert_eq!(percent_decode("Front%20Door"), "Front Door");
    assert_eq!(percent_decode("100%"), "100%");
    assert_eq!(percent_decode("%zz%2"), "%zz%2");
    assert_eq!(percent_decode("caf%C3%A9"), "café");
    assert_eq!(percent_decode("é%"), "é%");
}

#[test]
fn rtsp_options_answers_say_methods_and_server_only() {
    let a = parse_rtsp("RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: Hipcam RealServer/V1.0\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY\r\n\r\n").unwrap();
    assert_eq!(a.status, "RTSP/1.0 200 OK");
    assert_eq!(a.server.as_deref(), Some("Hipcam RealServer/V1.0"));
    assert_eq!(a.public.as_deref(), Some("OPTIONS, DESCRIBE, SETUP, PLAY"));
    assert!(parse_rtsp("HTTP/1.1 400 Bad Request\r\n").is_none());
    assert!(parse_rtsp("").is_none());
}

#[test]
fn evidence_is_clipped_on_a_character_boundary() {
    let long = "é".repeat(RAW_MAX);
    let c = clip(&long);
    assert!(c.len() <= RAW_MAX + "…".len());
    assert!(c.ends_with('…'));
    assert_eq!(clip("short"), "short");
}

#[test]
fn chunked_bodies_are_read_as_far_as_they_are_well_formed() {
    assert_eq!(
        super::super::scan::dechunk("4\r\n<roo\r\n3\r\nt/>\r\n0\r\n\r\n"),
        "<root/>"
    );
    assert_eq!(super::super::scan::dechunk("zz\r\nabc"), "");
    assert_eq!(super::super::scan::dechunk("ff\r\nshort"), "");
}

#[test]
fn connected_routes_are_read_when_iproute2_is_missing() {
    let text =
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
                eth0\t00000000\t010200C0\t0003\t0\t0\t0\t00000000\t0\t0\t0\n\
                eth0\t000200C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n\
                wlan0\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n\
                bad\t0001A8C0\t00000000\t0001\t0\t0\t600\t00FF00FF\t0\t0\t0\n\
                down\t0002A8C0\t00000000\t0000\t0\t0\t600\t00FFFFFF\t0\t0\t0\n";
    let r = parse_proc_route(text);
    assert_eq!(
        r,
        vec![
            ("eth0".to_string(), "192.0.2.0".parse().unwrap(), 24),
            ("wlan0".to_string(), "192.168.1.0".parse().unwrap(), 24)
        ]
    );
    // 192.0.2.0/24 is a documentation network, not RFC 1918: a scan would be refused
    assert!(!is_private("192.0.2.10".parse().unwrap()));
}
