#!/bin/bash

log() {
  echo -e "\n>>>>> $1\n"
}

fail() {
  echo "$1"
  exit 1
}

# Wrapping every command in this, in order to avoid a cascasing pile of errors
try_command() {
  eval "$1" || fail "This command failed: '$1'"
}

####################################################################################################

# This list should be extended as more demos are written!
directories=(
  bank/bank-backend
  # bank/bank-frontend

  e-commerce/payment-backend
  e-commerce/shop-backend
  e-commerce/shop-frontend

  greeting-emails
  shop-guide
  tpcc
  widget-store
  yky-social
)

orig_dir="$PWD"
demo_apps_dir="dbos-demo-apps"
all_lints_succeeded=true

plugin_version=$(try_command "jq -r '.version' package.json")
tarball_name="dbos-inc-eslint-plugin-$plugin_version.tgz"
tarball_path="$orig_dir/$tarball_name"

####################################################################################################

prepare_demo_apps_dir() {
  if [[ -d "$demo_apps_dir" ]]; then
    # This is here so that running the test locally won't involve a re-clone
    try_command "cd $demo_apps_dir"
    try_command "git restore ." # Cleaning up any changes made
    try_command "git pull" # Pulling the latest changes
    try_command "cd .."
  else
    try_command "git clone https://github.com/dbos-inc/$demo_apps_dir"
  fi
}

try_command "tsc"
try_command "npm pack"

prepare_demo_apps_dir

for directory in "${directories[@]}"; do
  try_command "cd $demo_apps_dir/$directory"
  try_command "cp $tarball_path ."
  try_command "npm install $tarball_name"

  npm run lint
  lint_result="$?"

  if [[ "$lint_result" -ne 0 ]]; then
    all_lints_succeeded=false
  fi

  log "Exit code for linting '$directory': $lint_result"

  try_command "cd $orig_dir"
done

log "Finished the e2e test"

if [[ "$all_lints_succeeded" = false ]]; then
  exit 1
fi

####################################################################################################
