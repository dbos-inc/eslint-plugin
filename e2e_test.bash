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

# TODO: clean up the works/fails comments later
directories=(
  e-commerce/payment-backend # Works
  e-commerce/shop-backend # Works (but emits some relevant warnings to fix)
  e-commerce/shop-frontend # Works

  greeting-emails # Fails
  shop-guide # Fails
  tpcc # Fails
  widget-store # Works (but emits a warning; not specific to my linter rules though; I should still fix it)
  yky-social # Works (but emits a warning; not specific to my linter rules though; I should still fix it)
)

orig_dir="$PWD"
demo_apps_dir="dbos-demo-apps"
all_lints_succeeded=true

plugin_version=$(try_command "jq -r '.version' package.json")
tarball_name="dbos-inc-eslint-plugin-$plugin_version.tgz"
tarball_path="$orig_dir/$tarball_name"

####################################################################################################

maybe_remove_demo_apps_dir() {
  if [[ -d "$demo_apps_dir" ]]; then

    log "Removing the demo apps directory"

    # Uncomment when running locally!
    # try_command "rm -r $demo_apps_dir"
  fi
}


try_command "tsc"
try_command "npm pack"

maybe_remove_demo_apps_dir
try_command "git clone https://github.com/dbos-inc/$demo_apps_dir"

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

maybe_remove_demo_apps_dir
log "Finished the e2e test"

if [[ "$all_lints_succeeded" = false ]]; then
  exit 1
fi

####################################################################################################
