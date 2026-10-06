# HARDWARE DOG / INSTALL

```text
THE INTERFACE   nothing to install: open it in Chrome or Edge
DOGD            the local daemon: one package, or one command to build it
```

The interface runs in the browser. dogd is what lets it see this
computer (its network, its USB devices) and Hardware Dog probes on serial
or TCP. Everything stays on this machine: dogd listens on 127.0.0.1 only.

---

## KALI, DEBIAN, UBUNTU (amd64, arm64)

From the project's **Releases** page, take `hwdog-dogd_VERSION_ARCH.deb`
and `SHA256SUMS`, then:

```sh
sha256sum --check --ignore-missing SHA256SUMS      # must say: OK
sudo apt install ./hwdog-dogd_*_amd64.deb          # arm64 on a Pi or an ARM laptop
dogd serve --source host                           # this computer: network and USB
```

Then in the interface: **START HERE → THIS COMPUTER**.

To start it with your session instead of by hand:

```sh
systemctl --user enable --now dogd                 # dogd serve --source host
systemctl --user status dogd
journalctl --user -u dogd -f                       # what it prints
```

A probe on a serial port: your user needs the port (log out and in after):

```sh
sudo usermod -aG dialout "$USER"
dogd serve --source serial:/dev/ttyACM0
```

Remove: `sudo apt remove hwdog-dogd`. Your sessions stay in
`~/.local/share/hwdog` until you delete them.

```text
INSTALLED   /usr/bin/dogd
            /usr/lib/systemd/user/dogd.service   (not enabled until you say so)
            /usr/share/doc/hwdog-dogd/           this page, DOGD.md, the license
NEEDS       glibc (the package says which version), nothing else
SENDS       nothing on its own. --source host reads the network and the USB
            list; the checks that send packets (ping the gateway, resolve
            a name, connect to 443) run only when the interface asks
            (docs/DOGD.md, docs/SECURITY.md)
```

---

## BUILD IT YOURSELF (any system)

```sh
git clone https://github.com/SEUB66/HardwareDog && cd HardwareDog/dogd
cargo build --release                              # Rust: https://rustup.rs
./target/release/dogd serve --source host
```

The same package, from your build:

```sh
packaging/deb/build-deb.sh                         # dist/hwdog-dogd_VERSION_ARCH.deb
```

The build is reproducible (CI builds dogd twice and compares the bytes);
the package dates every file from the last commit, so two builds of one
commit give the same `.deb`.

---

## A RELEASE (maintainers)

A tag `dogd-vX.Y.Z` matching `dogd/Cargo.toml` builds the packages for
amd64 and arm64 on Ubuntu 22.04 (glibc 2.35: runs on current Kali,
Debian 12 and Ubuntu 22.04 and later), installs each one, checks it
starts, and publishes them with `SHA256SUMS` on the Releases page
(`.github/workflows/release.yml`).
