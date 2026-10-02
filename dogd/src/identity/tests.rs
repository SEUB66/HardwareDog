//! The identity invariants, at the resolver level. Storage-level ones
//! (migration, persistence, aliases) are in storage/mod.rs.

use super::*;

fn dongle(port: &str, path: Option<&str>, serial: Option<&str>) -> Fingerprint {
    Fingerprint {
        transport: Some(Transport::Usb),
        vid: Some(0x1a86),
        pid: Some(0x7523),
        manufacturer: Some("QinHeng".into()),
        product: Some("USB Serial".into()),
        serial: serial.map(String::from),
        usb_path: path.map(String::from),
        interface: Some("1.0 class ff".into()),
        port: Some(port.into()),
        ..Default::default()
    }
}

fn known_from(id: &str, fp: &Fingerprint) -> Known {
    Known {
        id: id.into(),
        vid: fp.vid,
        pid: fp.pid,
        manufacturer: fp.manufacturer.clone(),
        product: fp.product.clone(),
        serial: fp.serial.clone(),
        usb_path: fp.usb_path.clone(),
        interface: fp.interface.clone(),
        mac: fp.mac.clone(),
        chip_id: fp.chip_id.clone(),
        ..Default::default()
    }
}

fn id_of(r: &Resolution) -> Option<&str> {
    match r {
        Resolution::Known { id, .. } => Some(id),
        _ => None,
    }
}

#[test]
fn replugging_the_same_device_is_the_same_device() {
    // With a serial, and without one (same socket).
    for serial in [Some("A50285BI"), None] {
        let first = dongle("/dev/ttyUSB0", Some("1-2"), serial);
        let known = [known_from("HW-1", &first)];
        let again = dongle("/dev/ttyUSB3", Some("1-2"), serial); // new tty number
        let s = usable_serial(&again, &[]);
        assert_eq!(
            id_of(&resolve(&again, &s, &known, &[])),
            Some("HW-1"),
            "serial {serial:?}"
        );
    }
}

#[test]
fn a_stable_id_survives_a_change_of_usb_port() {
    let first = dongle("COM3", Some("1-2"), Some("A50285BI"));
    let known = [known_from("HW-1", &first)];
    let moved = dongle("COM7", Some("2-1.4"), Some("A50285BI"));
    let r = resolve(&moved, &usable_serial(&moved, &[]), &known, &[]);
    assert_eq!(
        r,
        Resolution::Known {
            id: "HW-1".into(),
            strength: Strength::Excellent,
            basis: "serial a50285bi + 1A86:7523".into()
        }
    );

    let chip = Fingerprint {
        chip_id: Some("7CDFA13A1F2C".into()),
        port: Some("COM9".into()),
        ..Default::default()
    };
    let known = [Known {
        id: "HW-9".into(),
        chip_id: Some("7cdfa13a1f2c".into()),
        ..Default::default()
    }];
    assert_eq!(id_of(&resolve(&chip, &None, &known, &[])), Some("HW-9"));
}

#[test]
fn two_identical_devices_without_serial_are_told_apart() {
    let a = dongle("/dev/ttyUSB0", Some("1-2"), None);
    let b = dongle("/dev/ttyUSB1", Some("1-3"), None);
    // First sight of both: two new identities with different keys.
    assert_ne!(identity_key(&a, &None), identity_key(&b, &None));
    let known = [known_from("HW-A", &a), known_from("HW-B", &b)];
    // Both plugged back, each in its own socket: each finds itself.
    assert_eq!(
        id_of(&resolve(&a, &None, &known, &["HW-B".into()])),
        Some("HW-A")
    );
    assert_eq!(
        id_of(&resolve(&b, &None, &known, &["HW-A".into()])),
        Some("HW-B")
    );
    // One moved to a third socket while the other is away: not guessed.
    let c = dongle("/dev/ttyUSB2", Some("1-4"), None);
    assert!(
        matches!(resolve(&c, &None, &known, &[]), Resolution::Ambiguous { candidates, .. } if candidates.len() == 2)
    );
    // While B is plugged in, a third socket can only be A.
    assert_eq!(
        id_of(&resolve(&c, &None, &known, &["HW-B".into()])),
        Some("HW-A")
    );
}

#[test]
fn a_shared_or_fake_serial_is_not_trusted() {
    let a = dongle("/dev/ttyUSB0", Some("1-2"), Some("0001"));
    let b = dongle("/dev/ttyUSB1", Some("1-3"), Some("0001"));
    assert_eq!(usable_serial(&a, &[a.clone(), b.clone()]), None); // shared right now
    for fake in ["0", "0000", "aaaaaaaa", "123456789", "  "] {
        assert_eq!(
            usable_serial(&dongle("p", None, Some(fake)), &[]),
            None,
            "{fake}"
        );
    }
    assert_eq!(
        usable_serial(&dongle("p", None, Some("A50285BI")), &[]),
        Some("a50285bi".into())
    );
}

#[test]
fn a_missing_serial_never_breaks_the_resolver() {
    let bare = Fingerprint {
        vid: Some(1),
        pid: Some(2),
        port: Some("COM4".into()),
        ..Default::default()
    };
    let r = resolve(&bare, &usable_serial(&bare, &[]), &[], &[]);
    assert!(matches!(
        r,
        Resolution::New {
            strength: Strength::Medium,
            ..
        }
    ));
    let known = [Known {
        id: "HW-X".into(),
        vid: Some(1),
        pid: Some(2),
        ..Default::default()
    }];
    assert_eq!(id_of(&resolve(&bare, &None, &known, &[])), Some("HW-X"));
}

#[test]
fn a_port_name_is_never_an_identity() {
    let just_a_port = Fingerprint {
        port: Some("COM3".into()),
        ..Default::default()
    };
    // Even with a known device that was last seen on COM3.
    let known = [Known {
        id: "HW-1".into(),
        ..Default::default()
    }];
    assert!(matches!(
        resolve(&just_a_port, &None, &known, &[]),
        Resolution::Unidentified { .. }
    ));
    // And the port takes no part in the key of an identity.
    let a = dongle("COM3", Some("1-2"), Some("A50285BI"));
    let b = dongle("COM8", Some("1-2"), Some("A50285BI"));
    assert_eq!(
        identity_key(&a, &usable_serial(&a, &[])),
        identity_key(&b, &usable_serial(&b, &[]))
    );
}

#[test]
fn different_strong_ids_are_never_merged() {
    // Same VID:PID, same socket, but another serial: another device.
    let known = [known_from(
        "HW-1",
        &dongle("p", Some("1-2"), Some("A50285BI")),
    )];
    let other = dongle("p", Some("1-2"), Some("B77712QX"));
    let r = resolve(&other, &usable_serial(&other, &[]), &known, &[]);
    assert!(matches!(
        r,
        Resolution::New {
            strength: Strength::Excellent,
            ..
        }
    ));
    // Another chip id on the same port: another board.
    let known = [Known {
        id: "HW-9".into(),
        chip_id: Some("7cdfa1000001".into()),
        vid: Some(0x303a),
        pid: Some(0x1001),
        usb_path: Some("1-2".into()),
        ..Default::default()
    }];
    let fp = Fingerprint {
        chip_id: Some("7cdfa1000002".into()),
        vid: Some(0x303a),
        pid: Some(0x1001),
        usb_path: Some("1-2".into()),
        ..Default::default()
    };
    assert!(matches!(
        resolve(&fp, &None, &known, &[]),
        Resolution::New {
            strength: Strength::Excellent,
            ..
        }
    ));
}

#[test]
fn a_strong_key_is_never_folded_into_a_weaker_record() {
    // Known by its socket only: its past may be another board's.
    let fp0 = Fingerprint {
        vid: Some(0x303a),
        pid: Some(0x1001),
        usb_path: Some("1-2".into()),
        ..Default::default()
    };
    let known = [known_from("HW-P", &fp0)];
    let with_chip = Fingerprint {
        chip_id: Some("7cdfa13a1f2c".into()),
        ..fp0.clone()
    };
    assert_eq!(
        resolve(&with_chip, &None, &known, &[]),
        Resolution::New {
            strength: Strength::Excellent,
            basis: "chip id 7cdfa13a1f2c".into(),
            hint: Some("HW-P".into())
        }
    );
    // Known by its legacy 24-bit HDP id: the same, a hint, not a merge.
    let legacy = [Known {
        id: "HW-L".into(),
        legacy_id: Some("HD-3A1F2C".into()),
        ..Default::default()
    }];
    let hello = Fingerprint {
        chip_id: Some("7cdfa13a1f2c".into()),
        legacy_id: Some("HD-3A1F2C".into()),
        ..Default::default()
    };
    assert!(matches!(
        resolve(&hello, &None, &legacy, &[]),
        Resolution::New { hint: Some(h), strength: Strength::Excellent, .. } if h == "HW-L"
    ));
    // Two excellent keys that agree (trusted serial, then its chip id): one device.
    let sn = dongle("p", Some("1-2"), Some("A50285BI"));
    let known = [known_from("HW-S", &sn)];
    let sn_chip = Fingerprint {
        chip_id: Some("7cdfa13a1f2c".into()),
        ..sn.clone()
    };
    assert_eq!(
        id_of(&resolve(
            &sn_chip,
            &usable_serial(&sn_chip, &[]),
            &known,
            &[]
        )),
        Some("HW-S")
    );
}

#[test]
fn a_legacy_24_bit_id_is_only_a_hint() {
    let old = |id: &str| Known {
        id: id.into(),
        legacy_id: Some("HD-3A1F2C".into()),
        ..Default::default()
    };
    let hello = Fingerprint {
        legacy_id: Some("hd-3a1f2c".into()),
        port: Some("tcp:10.0.0.7:3333".into()),
        ..Default::default()
    };
    // Never EXCELLENT, even when it matches.
    assert_eq!(
        resolve(&hello, &None, &[old("HW-1")], &[]),
        Resolution::Known {
            id: "HW-1".into(),
            strength: Strength::Good,
            basis: "HDP device id hd-3a1f2c (24 bits, legacy)".into()
        }
    );
    // Two boards whose MACs end alike: not chosen.
    assert!(matches!(
        resolve(&hello, &None, &[old("HW-1"), old("HW-2")], &[]),
        Resolution::Ambiguous { candidates, .. } if candidates.len() == 2
    ));
    // Unknown: a new identity, GOOD at best.
    assert!(matches!(
        resolve(&hello, &None, &[], &[]),
        Resolution::New {
            strength: Strength::Good,
            ..
        }
    ));
    // Two different 48-bit chip ids with the same 24-bit tail: two devices.
    let a = Known {
        chip_id: Some("7cdfa13a1f2c".into()),
        ..old("HW-A")
    };
    let b = Fingerprint {
        chip_id: Some("0011223a1f2c".into()),
        ..hello.clone()
    };
    assert!(matches!(
        resolve(&b, &None, &[a], &[]),
        Resolution::New { hint: None, .. }
    ));
}

#[test]
fn ids_are_deterministic() {
    let a = dongle("COM3", Some("1-2"), Some("A50285BI"));
    let id = identity_id(&identity_key(&a, &usable_serial(&a, &[])));
    assert_eq!(id, identity_id(&identity_key(&a, &usable_serial(&a, &[]))));
    // 96 bits: 24 hex digits.
    assert!(id.starts_with("HW-") && id.len() == 27, "{id}");
}

#[test]
fn hot_plug_events_are_clean() {
    let mut p = Presence::default();
    let a = dongle("/dev/ttyUSB0", Some("1-2"), None);
    let b = dongle("/dev/ttyUSB1", Some("1-3"), None);
    assert_eq!(p.update(vec![a.clone()]).len(), 1); // attach
    assert!(p.update(vec![a.clone()]).is_empty()); // same scan: nothing
    let ev = p.update(vec![a.clone(), b.clone()]);
    assert_eq!(
        ev,
        vec![PlugEvent::Attached {
            port: "/dev/ttyUSB1".into(),
            fingerprint: b.clone()
        }]
    );
    let ev = p.update(vec![b.clone()]);
    assert_eq!(
        ev,
        vec![PlugEvent::Detached {
            port: "/dev/ttyUSB0".into(),
            fingerprint: a.clone()
        }]
    );
    // Another device appears under the same port name: detach, then attach.
    let c = dongle("/dev/ttyUSB1", Some("1-3"), Some("A50285BI"));
    let ev = p.update(vec![c.clone()]);
    assert!(matches!(
        ev.as_slice(),
        [PlugEvent::Detached { .. }, PlugEvent::Attached { .. }]
    ));
    assert_eq!(p.update(vec![]).len(), 1);
}

#[cfg(unix)]
#[test]
fn usb_topology_is_read_from_sysfs() {
    use std::os::unix::fs::symlink;
    let root = std::env::temp_dir().join(format!("dogd-sys-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    // CDC ACM: the tty's device link is the interface directory.
    let acm = root.join("devices/pci0000:00/0000:00:14.0/usb1/1-2/1-2.3/1-2.3:1.0");
    std::fs::create_dir_all(&acm).unwrap();
    std::fs::write(acm.join("bInterfaceClass"), "02\n").unwrap();
    std::fs::create_dir_all(root.join("class/tty/ttyACM0")).unwrap();
    symlink(&acm, root.join("class/tty/ttyACM0/device")).unwrap();
    // usb-serial (FTDI, CH340): the link points below the interface.
    let usb = root.join("devices/pci0000:00/0000:00:14.0/usb1/1-4/1-4:1.0/ttyUSB0");
    std::fs::create_dir_all(&usb).unwrap();
    std::fs::create_dir_all(root.join("class/tty/ttyUSB0")).unwrap();
    symlink(&usb, root.join("class/tty/ttyUSB0/device")).unwrap();

    assert_eq!(
        usb_topology(&root, "/dev/ttyACM0"),
        (Some("1-2.3".into()), Some("1.0 class 02".into()))
    );
    assert_eq!(
        usb_topology(&root, "/dev/ttyUSB0"),
        (Some("1-4".into()), Some("1.0".into()))
    );
    assert_eq!(usb_topology(&root, "/dev/ttyS0"), (None, None)); // not USB
    assert_eq!(usb_topology(&root, "COM3"), (None, None)); // not Linux
    let _ = std::fs::remove_dir_all(&root);
}
