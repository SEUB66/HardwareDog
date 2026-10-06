#!/usr/bin/env bash
# Build the Debian / Kali / Ubuntu package of dogd: hwdog-dogd_VERSION_ARCH.deb
#
#   packaging/deb/build-deb.sh [path/to/dogd] [arch]
#
# Defaults: dogd/target/release/dogd, the architecture of this machine.
# The package is reproducible: every file dated from the last commit
# (SOURCE_DATE_EPOCH), owned by root, in a fixed order.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
bin="${1:-$repo/dogd/target/release/dogd}"
arch="${2:-$(dpkg --print-architecture)}"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$repo/dogd/Cargo.toml" | head -1)"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$repo" log -1 --format=%ct)}"

[ -x "$bin" ] || { echo "no dogd binary at $bin: cargo build --release in dogd/" >&2; exit 1; }

# The oldest glibc the binary needs: the package says so, apt checks it.
glibc="$(objdump -T "$bin" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)"

out="$repo/dist"
pkg="$(mktemp -d)"
trap 'rm -rf "$pkg"' EXIT
root="$pkg/hwdog-dogd_${version}_${arch}"

install -Dm0755 "$bin" "$root/usr/bin/dogd"
install -Dm0644 "$here/dogd.service" "$root/usr/lib/systemd/user/dogd.service"
install -Dm0644 "$repo/LICENSE" "$root/usr/share/doc/hwdog-dogd/copyright"
install -Dm0644 "$repo/docs/DOGD.md" "$root/usr/share/doc/hwdog-dogd/DOGD.md"
install -Dm0644 "$repo/docs/INSTALL.md" "$root/usr/share/doc/hwdog-dogd/INSTALL.md"

size="$(du -ks "$root/usr" | cut -f1)"
mkdir -p "$root/DEBIAN"
cat > "$root/DEBIAN/control" <<CONTROL
Package: hwdog-dogd
Version: $version
Architecture: $arch
Maintainer: Sebastien Germain <129697590+SEUB66@users.noreply.github.com>
Depends: libc6 (>= $glibc), libgcc-s1
Installed-Size: $size
Section: electronics
Priority: optional
Homepage: https://github.com/SEUB66/HardwareDog
Description: Hardware Dog local daemon
 dogd links Hardware Dog probes, and this computer itself, to the
 Hardware Dog interface: serial and TCP devices, this computer's network
 (link, DHCP, gateway, DNS, Internet) and its USB devices, with a local
 session store. Local only: it listens on 127.0.0.1, sends no telemetry,
 needs no account.
 .
 Run: dogd serve --source host
CONTROL

# Reproducible: every date the commit's, every mode fixed.
find "$root" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
mkdir -p "$out"
deb="$out/hwdog-dogd_${version}_${arch}.deb"
dpkg-deb --root-owner-group -Zxz --build "$root" "$deb" >/dev/null
echo "$deb"
