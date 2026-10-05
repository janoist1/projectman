#!/bin/sh
# Harmless probes. Prints key=value results only (no secret values).
W=/tmp/pm-agy-probe
t() { if eval "$2" >/dev/null 2>&1; then echo "$1=OK"; else echo "$1=FAIL"; fi; }
t write_workspace "echo x > $W/ws/sb-inside.txt"
t write_outside_in_work "echo x > $W/outside/sb-outside.txt"
t write_adddir "echo x > $W/adddir/sb-adddir.txt"
t read_adddir "cat $W/adddir/pre.txt"
t read_outside_not_added "cat $W/outside/pre.txt"
t write_system_tmp "echo x > /tmp/agy-probe-sb-$$.txt && rm -f /tmp/agy-probe-sb-$$.txt"
t read_gemini_dir_listing "ls $HOME/.gemini"
t network_curl "curl -sI --max-time 6 https://example.com"
echo "proc_visible_count=$(ps -A -o pid= 2>/dev/null | wc -l | tr -d ' ')"
echo "proc_with_visible_env_count=$(ps eww -A -o command= 2>/dev/null | grep -c ' HOME=')"
echo "env_var_count=$(env | wc -l | tr -d ' ')"
echo "env_has_ANTIGRAVITY_vars=$(env | cut -d= -f1 | grep -c '^ANTIGRAVITY')"
echo "env_names=$(env | cut -d= -f1 | sort | tr '\n' ' ' | cut -c1-600)"
echo "whoami_home_set=$([ -n "$HOME" ] && echo yes || echo no)"
