#!/bin/bash
# Public bootstrap only. Secrets and board data travel over the later SSH/SSM host session.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y openssh-server ec2-instance-connect snapd
systemctl enable --now ssh
if ! snap list amazon-ssm-agent >/dev/null 2>&1; then
  snap install amazon-ssm-agent --classic
fi
snap start --enable amazon-ssm-agent
