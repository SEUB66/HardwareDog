//! BlueZ over the system D-Bus: find the adapter, start LE discovery with
//! duplicate reports on, turn every Device1 property update into a report,
//! stop discovery when asked. Errors keep BlueZ's own names.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use futures_util::StreamExt;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream, Proxy};

use super::{hex, BleScanner, Observation, Status};

const BLUEZ: &str = "org.bluez";

/// What a D-Bus error means for the operator, from its name.
fn explain(e: &zbus::Error) -> Status {
    if let zbus::Error::MethodError(name, desc, _) = e {
        let d = desc.clone().unwrap_or_default();
        return match name.as_str() {
            "org.bluez.Error.NotReady" => Status::new(
                "no_adapter",
                None,
                format!("the adapter is not ready (powered off?) [{name}] {d}"),
            ),
            "org.bluez.Error.NotAuthorized" | "org.freedesktop.DBus.Error.AccessDenied" => {
                Status::new(
                    "permission",
                    None,
                    format!("discovery refused [{name}] {d}"),
                )
            }
            "org.freedesktop.DBus.Error.ServiceUnknown"
            | "org.freedesktop.DBus.Error.NameHasNoOwner" => Status::new(
                "error",
                None,
                format!("BlueZ (bluetoothd) is not running [{name}]"),
            ),
            _ => Status::new("error", None, format!("[{name}] {d}")),
        };
    }
    Status::new("error", None, e.to_string())
}

type Objects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedValue>>>;

async fn objects(conn: &Connection) -> zbus::Result<Objects> {
    let om = zbus::fdo::ObjectManagerProxy::builder(conn)
        .destination(BLUEZ)?
        .path("/")?
        .build()
        .await?;
    let raw = om.get_managed_objects().await?;
    Ok(raw
        .into_iter()
        .map(|(path, ifaces)| {
            (
                path,
                ifaces
                    .into_iter()
                    .map(|(i, p)| (i.to_string(), p))
                    .collect(),
            )
        })
        .collect())
}

/// The first adapter BlueZ lists: (object path, its address).
fn adapter(objs: &Objects) -> Option<(String, Option<String>)> {
    let mut found: Vec<(String, Option<String>)> = objs
        .iter()
        .filter_map(|(path, ifaces)| {
            ifaces
                .get("org.bluez.Adapter1")
                .map(|props| (path.to_string(), props.get("Address").and_then(|v| text(v))))
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

fn label(path: &str, address: &Option<String>) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match address {
        Some(a) => format!("{name} {a}"),
        None => name.to_string(),
    }
}

/// Is BlueZ there, with an adapter? Used for the status while idle.
pub async fn probe() -> Status {
    let conn = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            return Status::new(
                "error",
                None,
                format!("the system D-Bus is not reachable: {e}"),
            )
        }
    };
    let objs = match objects(&conn).await {
        Ok(o) => o,
        Err(e) => return explain(&e),
    };
    match adapter(&objs) {
        None => Status::new("no_adapter", None, "BlueZ lists no Bluetooth adapter"),
        Some((path, addr)) => {
            let powered = objs
                .iter()
                .find(|(p, _)| p.as_str() == path)
                .and_then(|(_, i)| i.get("org.bluez.Adapter1"))
                .and_then(|p| p.get("Powered"))
                .and_then(|v| match unwrap(v) {
                    Value::Bool(b) => Some(*b),
                    _ => None,
                });
            let name = label(&path, &addr);
            if powered == Some(false) {
                Status::new("no_adapter", Some(name), "the adapter is powered off")
            } else {
                Status::new("ready", Some(name.clone()), format!("adapter {name}"))
            }
        }
    }
}

fn unwrap<'a>(v: &'a Value<'a>) -> &'a Value<'a> {
    let mut v = v;
    while let Value::Value(inner) = v {
        v = inner;
    }
    v
}

fn text(v: &Value) -> Option<String> {
    match unwrap(v) {
        Value::Str(s) => Some(s.to_string()),
        _ => None,
    }
}

fn int16(v: &Value) -> Option<i16> {
    match unwrap(v) {
        Value::I16(n) => Some(*n),
        Value::I32(n) => i16::try_from(*n).ok(),
        _ => None,
    }
}

fn bytes(v: &Value) -> Option<Vec<u8>> {
    match unwrap(v) {
        Value::Array(a) => a
            .inner()
            .iter()
            .map(|x| match x {
                Value::U8(b) => Some(*b),
                _ => None,
            })
            .collect(),
        _ => None,
    }
}

/// a{qv} (ManufacturerData) or a{sv} (ServiceData) -> key -> hex bytes.
fn payloads(v: &Value) -> Option<BTreeMap<String, String>> {
    match unwrap(v) {
        Value::Dict(d) => Some(
            d.iter()
                .filter_map(|(k, v)| {
                    let key = match unwrap(k) {
                        Value::U16(n) => n.to_string(),
                        Value::Str(s) => s.to_lowercase(),
                        _ => return None,
                    };
                    bytes(v).map(|b| (key, hex(&b)))
                })
                .collect(),
        ),
        _ => None,
    }
}

fn strings(v: &Value) -> Option<Vec<String>> {
    match unwrap(v) {
        Value::Array(a) => Some(a.inner().iter().filter_map(text).collect()),
        _ => None,
    }
}

/// The last known state of a device, by its object path.
#[derive(Default, Clone)]
pub(crate) struct Known {
    obs: Observation,
}

/// Apply a Device1 property map. Returns true when it is an advertisement
/// report worth a line (RSSI or payload updated, or first sight).
pub(crate) fn apply(known: &mut Known, props: &HashMap<String, Value>, first: bool) -> bool {
    let o = &mut known.obs;
    let mut report = first;
    for (k, v) in props {
        match k.as_str() {
            "Address" => {
                if let Some(a) = text(v) {
                    o.address = a;
                }
            }
            "AddressType" => o.address_type = text(v),
            "Name" => o.name = text(v),
            "Alias" => o.alias = text(v),
            "RSSI" => {
                o.rssi = int16(v);
                report = true;
            }
            "TxPower" => o.tx_power = int16(v),
            "UUIDs" => o.uuids = strings(v).unwrap_or_default(),
            "ManufacturerData" => {
                o.manufacturer = payloads(v).unwrap_or_default();
                report = true;
            }
            "ServiceData" => {
                o.service_data = payloads(v).unwrap_or_default();
                report = true;
            }
            _ => {}
        }
    }
    report && !o.address.is_empty()
}

fn borrowed(props: &HashMap<String, OwnedValue>) -> HashMap<String, Value<'_>> {
    props
        .iter()
        .map(|(k, v)| (k.clone(), Value::from(v.clone())))
        .collect()
}

pub async fn run(
    scanner: Arc<BleScanner>,
    mut stop: tokio::sync::oneshot::Receiver<()>,
    ready: tokio::sync::oneshot::Sender<Status>,
) {
    let conn = match Connection::system().await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Status::new(
                "error",
                None,
                format!("the system D-Bus is not reachable: {e}"),
            ));
            return;
        }
    };
    let objs = match objects(&conn).await {
        Ok(o) => o,
        Err(e) => {
            let _ = ready.send(explain(&e));
            return;
        }
    };
    let Some((path, addr)) = adapter(&objs) else {
        let _ = ready.send(Status::new(
            "no_adapter",
            None,
            "BlueZ lists no Bluetooth adapter",
        ));
        return;
    };
    let name = label(&path, &addr);
    let proxy = match Proxy::new(&conn, BLUEZ, path.clone(), "org.bluez.Adapter1").await {
        Ok(p) => p,
        Err(e) => {
            let _ = ready.send(explain(&e));
            return;
        }
    };
    // Signals first, then discovery: no report between the two is missed.
    let rule = MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.DBus.Properties")
        .and_then(|b| b.member("PropertiesChanged"))
        .and_then(|b| b.path_namespace(path.clone()))
        .map(|b| b.build());
    let changes = match rule {
        Ok(r) => MessageStream::for_match_rule(r, &conn, Some(1024)).await,
        Err(e) => Err(e),
    };
    let om = zbus::fdo::ObjectManagerProxy::builder(&conn)
        .destination(BLUEZ)
        .and_then(|b| b.path("/"));
    let added = match om {
        Ok(b) => match b.build().await {
            Ok(om) => match om.receive_interfaces_added().await {
                Ok(a) => om.receive_interfaces_removed().await.map(|r| (a, r)),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        },
        Err(e) => Err(e),
    };
    let (mut changes, (mut added, mut removed)) = match (changes, added) {
        (Ok(c), Ok(a)) => (c, a),
        (Err(e), _) | (_, Err(e)) => {
            let _ = ready.send(explain(&e));
            return;
        }
    };
    let mut filter: HashMap<&str, Value> = HashMap::new();
    filter.insert("Transport", Value::from("le"));
    filter.insert("DuplicateData", Value::from(true));
    // A filter refused is not fatal (old BlueZ): discovery still runs, said in the detail.
    let filtered = proxy
        .call_method("SetDiscoveryFilter", &(filter,))
        .await
        .is_ok();
    if let Err(e) = proxy.call_method("StartDiscovery", &()).await {
        let mut s = explain(&e);
        s.adapter = Some(name);
        let _ = ready.send(s);
        return;
    }
    let detail = if filtered {
        format!("discovering on {name} (LE, duplicate reports on)")
    } else {
        format!("discovering on {name} (this BlueZ refused the LE filter: reports may be fewer)")
    };
    let _ = ready.send(Status::new("scanning", Some(name.clone()), detail));

    let prefix = format!("{path}/");
    let mut known: HashMap<String, Known> = HashMap::new();
    // Devices BlueZ already knows: their cached properties are not a report yet.
    for (p, ifaces) in &objs {
        if let Some(props) = ifaces.get("org.bluez.Device1") {
            if p.as_str().starts_with(&prefix) {
                let mut k = Known::default();
                k.obs.adapter = name.clone();
                apply(&mut k, &borrowed(props), false);
                known.insert(p.to_string(), k);
            }
        }
    }
    // How the scan ended when it was not asked to (adapter off or gone).
    let mut ended: Option<Status> = None;
    loop {
        tokio::select! {
            _ = &mut stop => break,
            Some(sig) = removed.next() => {
                let Ok(args) = sig.args() else { continue };
                let p = args.object_path().to_string();
                if p == path.as_str() && args.interfaces().iter().any(|i| i.as_str() == "org.bluez.Adapter1") {
                    ended = Some(Status::new("no_adapter", Some(name.clone()), format!("adapter {name} disappeared (unplugged, or bluetoothd stopped): discovery ended")));
                    break;
                }
                // BlueZ forgets a device it has not heard for a while: so does this scan.
                if p.starts_with(&prefix) { known.remove(&p); }
            }
            Some(sig) = added.next() => {
                let Ok(args) = sig.args() else { continue };
                let p = args.object_path().to_string();
                if !p.starts_with(&prefix) { continue; }
                if let Some(props) = args.interfaces_and_properties().get("org.bluez.Device1") {
                    let props: HashMap<String, Value> = props.iter().map(|(k, v)| (k.to_string(), v.try_clone().unwrap_or(Value::Bool(false)))).collect();
                    let k = known.entry(p).or_insert_with(|| { let mut k = Known::default(); k.obs.adapter = name.clone(); k });
                    if apply(k, &props, true) { scanner.push(k.obs.clone()); }
                }
            }
            Some(msg) = changes.next() => {
                let Ok(msg) = msg else { continue };
                let Some(p) = msg.header().path().map(|p| p.to_string()) else { continue };
                let body = msg.body();
                let Ok((iface, props, _)) = body.deserialize::<(String, HashMap<String, OwnedValue>, Vec<String>)>() else { continue };
                if p == path.as_str() && iface == "org.bluez.Adapter1" {
                    let off = |k: &str| props.get(k).and_then(|v| bool::try_from(v).ok()) == Some(false);
                    if off("Powered") {
                        ended = Some(Status::new("error", Some(name.clone()), format!("adapter {name} was powered off: discovery ended")));
                        break;
                    }
                    if off("Discovering") {
                        ended = Some(Status::new("error", Some(name.clone()), format!("discovery on {name} was stopped by the system (another program, or bluetoothd)")));
                        break;
                    }
                    continue;
                }
                if !p.starts_with(&prefix) || iface != "org.bluez.Device1" { continue; }
                let k = known.entry(p).or_insert_with(|| { let mut k = Known::default(); k.obs.adapter = name.clone(); k });
                if apply(k, &borrowed(&props), false) { scanner.push(k.obs.clone()); }
            }
            else => break,
        }
    }
    if let Some(s) = ended {
        scanner.set_status(s);
        return;
    }
    let _ = proxy.call_method("StopDiscovery", &()).await;
    scanner.set_status(Status::new(
        "ready",
        Some(name.clone()),
        format!("adapter {name}, discovery stopped"),
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use zbus::zvariant::{Array, Dict, Signature};

    #[test]
    fn device_properties_become_a_report() {
        let mut k = Known::default();
        let mut props: HashMap<String, Value> = HashMap::new();
        props.insert("Address".into(), Value::from("C0:FF:EE:00:00:01"));
        props.insert("AddressType".into(), Value::from("random"));
        props.insert("Name".into(), Value::from("Sensor"));
        props.insert("RSSI".into(), Value::I16(-61));
        let mut mfr = Dict::new(&Signature::U16, &Signature::Variant);
        mfr.append(
            Value::U16(0x004c),
            Value::Value(Box::new(Value::Array(Array::from(vec![0x02u8, 0x15])))),
        )
        .unwrap();
        props.insert("ManufacturerData".into(), Value::Dict(mfr));
        assert!(apply(&mut k, &props, false));
        assert_eq!(k.obs.address, "C0:FF:EE:00:00:01");
        assert_eq!(k.obs.address_type.as_deref(), Some("random"));
        assert_eq!(k.obs.rssi, Some(-61));
        assert_eq!(
            k.obs.manufacturer.get("76").map(String::as_str),
            Some("0215")
        );
        // A name change alone is not an advertisement report.
        let mut only_name: HashMap<String, Value> = HashMap::new();
        only_name.insert("Alias".into(), Value::from("Kitchen"));
        assert!(!apply(&mut k, &only_name, false));
    }

    #[test]
    fn bluez_errors_keep_their_names() {
        let e = zbus::Error::MethodError(
            zbus::names::OwnedErrorName::try_from("org.bluez.Error.NotReady").unwrap(),
            Some("Resource Not Ready".into()),
            zbus::message::Message::method_call("/", "x")
                .unwrap()
                .build(&())
                .unwrap(),
        );
        let s = explain(&e);
        assert_eq!(s.state, "no_adapter");
        assert!(s.detail.contains("org.bluez.Error.NotReady"));
    }
}
