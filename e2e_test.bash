#!/bin/bash

fail() {
  echo "$1"
  exit 1
}

# Wrapping every command in this, in order to avoid a cascasing pile of errors
try_command() {
  eval "$1" || fail "This command failed: '$1'"
}

####################################################################################################

directories=(
  e-commerce/payment-backend e-commerce/shop-backend e-commerce/shop-frontend
  greeting-emails shop-guide tpcc widget-store yky-social
)

# TODO: will I have `jq` available in the CI environment?
orig_dir="$PWD"
version=$(try_command "jq -r '.version' package.json")

tarball_name="dbos-inc-eslint-plugin-$version.tgz"
tarball_path="$orig_dir/$tarball_name"

try_command "tsc"
try_command "npm pack"
try_command "git clone https://github.com/dbos-inc/dbos-demo-apps"

for directory in "${directories[@]}"; do
  echo ">>>>>>>>>> Running e2e test for $directory"

  try_command "cd dbos-demo-apps/$directory"
  try_command "cp $tarball_path ."
  try_command "npm install $tarball_name"
  try_command "npm run lint"

  try_command "cd $orig_dir"
done

####################################################################################################
