#!/usr/bin/env bash
# Creates, feeds and reaches the managed VM from a Mac with Multipass (PM-137). Runs on the Mac.
#
#   deploy/vm/mac-multipass.sh create  --ssh-key ~/.ssh/<name>.pub [--name NAME] [--cpus N] [--memory SIZE] [--disk SIZE]
#   deploy/vm/mac-multipass.sh deploy  [--name NAME] --workers "handle handle ..."
#   deploy/vm/mac-multipass.sh forward --ssh-key ~/.ssh/<name> [--name NAME]    # then open http://127.0.0.1:4700
#   deploy/vm/mac-multipass.sh destroy [--name NAME] --yes
#
# Nothing is shared with the Mac: no folder is ever mounted into the guest, the instance is not the
# 'primary' one (Multipass mounts the home directory into that one), the files go in with
# `multipass transfer`, and ssh agent forwarding is off. It only ever touches the instance
# named NAME (default projectman-vm) and refuses the names of instances it must not touch.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
NAME=projectman-vm
CPUS=2
MEMORY=4G
DISK=10G
SSH_KEY=
WORKERS=
YES=0

cmd=${1:-}
[ -n "$cmd" ] && shift
while [ $# -gt 0 ]; do
  case $1 in
    --name) NAME=${2:?}; shift 2 ;;
    --cpus) CPUS=${2:?}; shift 2 ;;
    --memory) MEMORY=${2:?}; shift 2 ;;
    --disk) DISK=${2:?}; shift 2 ;;
    --ssh-key) SSH_KEY=${2:?}; shift 2 ;;
    --workers) WORKERS=${2:?}; shift 2 ;;
    --yes) YES=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

case $NAME in
  primary|debian-vm) echo "refusing to use the instance name '$NAME'" >&2; exit 2 ;;
esac
printf '%s' "$NAME" | grep -Eq '^[a-z][a-z0-9-]{0,30}$' || { echo "bad instance name" >&2; exit 2; }
command -v multipass >/dev/null || { echo "multipass is not installed" >&2; exit 2; }

instance_ip() { multipass info "$NAME" | awk '/^IPv4/ {print $2; exit}'; }

case $cmd in
  create)
    [ -n "$SSH_KEY" ] || { echo "--ssh-key needs the PUBLIC key file to let in (e.g. ~/.ssh/id_ed25519.pub)" >&2; exit 2; }
    case $SSH_KEY in *.pub) ;; *) echo "--ssh-key must be a .pub file: never hand a private key over" >&2; exit 2 ;; esac
    key=$(cut -d' ' -f1-2 "$SSH_KEY")
    printf '%s' "$key" | grep -Eq '^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+$' || { echo "$SSH_KEY does not hold an ssh-ed25519 or ssh-rsa public key" >&2; exit 2; }
    if multipass info "$NAME" >/dev/null 2>&1; then echo "an instance named $NAME exists already; not touching it" >&2; exit 2; fi
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    sed "s|__SSH_PUBLIC_KEY__|$key|" "$here/cloud-init.yaml" > "$tmp/cloud-init.yaml"
    multipass launch 24.04 --name "$NAME" --cpus "$CPUS" --memory "$MEMORY" --disk "$DISK" --cloud-init "$tmp/cloud-init.yaml"
    multipass exec "$NAME" -- cloud-init status --wait
    echo "created $NAME at $(instance_ip) (admin account: ubuntu)"
    ;;
  deploy)
    [ -n "$WORKERS" ] || { echo "--workers needs the member handles" >&2; exit 2; }
    cd "$repo"
    [ -z "$(git status --porcelain)" ] || { echo "the working tree is not clean: commit first, the VM must run a recorded commit" >&2; exit 2; }
    commit=$(git rev-parse HEAD)
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    git archive --format=tar.gz -o "$tmp/projectman.tar.gz" HEAD
    multipass transfer "$tmp/projectman.tar.gz" "$NAME:/home/ubuntu/projectman.tar.gz"
    multipass exec "$NAME" -- sh -c 'rm -rf "$HOME/pm-src" && mkdir "$HOME/pm-src" && tar -xzf "$HOME/projectman.tar.gz" -C "$HOME/pm-src"'
    multipass exec "$NAME" -- sudo bash /home/ubuntu/pm-src/deploy/vm/bootstrap.sh --workers "$WORKERS" --admin-user ubuntu
    multipass exec "$NAME" -- sudo bash /home/ubuntu/pm-src/deploy/vm/install-app.sh --archive /home/ubuntu/projectman.tar.gz --commit "$commit" --smoke
    echo "deployed $commit; next: docs/VM.md (logins, first owner, verify)"
    ;;
  forward)
    [ -n "$SSH_KEY" ] || { echo "--ssh-key needs the PRIVATE key file that matches the public one" >&2; exit 2; }
    ip=$(instance_ip)
    [ -n "$ip" ] || { echo "no address for $NAME" >&2; exit 2; }
    echo "forwarding 127.0.0.1:4700 to the app in $NAME ($ip); Ctrl-C ends it"
    exec ssh -N -a -o ForwardAgent=no -o IdentitiesOnly=yes -i "$SSH_KEY" -L 127.0.0.1:4700:127.0.0.1:4700 "ubuntu@$ip"
    ;;
  destroy)
    [ "$YES" = 1 ] || { echo "destroy deletes $NAME and its disk for good: add --yes" >&2; exit 2; }
    multipass delete --purge "$NAME"
    ;;
  *) echo "usage: mac-multipass.sh create|deploy|forward|destroy (see the header of this file)" >&2; exit 2 ;;
esac
