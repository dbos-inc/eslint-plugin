#!/usr/local/opt/bash/bin/bash
# Using this shebang b/c I need associatiative arrays on MacOS,
# and it only has the old Bash by default which does not have that.
# I got most of this path from this command: `brew --prefix bash`

# This script exists to upgrade the plugin in a bunch of DBOS repos.
# Doing it manually takes a while (including installing the new version,
# making sure it lints correctly, and making a PR), so I made this script to automate that.

####################################################################################################

set -e

log() {
  echo -e "\n>>>>> $1\n"
}

####################################################################################################

demo_app_directories=(
  bank/bank-backend
  bank/bank-frontend

  e-commerce/payment-backend
  e-commerce/shop-backend
  e-commerce/shop-frontend

  greeting-emails
  shop-guide
  tpcc
  widget-fulfillment
  widget-store
  yky-social
)

transact_directories=(
  packages/create/templates/hello
  packages/create/templates/hello-prisma
  packages/create/templates/hello-typeorm
)

declare -A repos_with_upgradeable_directories=(
  ["dbos-demo-apps"]="${demo_app_directories[@]}"
  ["dbos-transact"]="${transact_directories[@]}"
  ["guestbook"]="."
  ["dbos-stored-proc-benchmark"]="."
  ["dbos-account-management"]="."
)

####################################################################################################

get_eslint_plugin_version() {
  version_with_caret=$(jq -r '.devDependencies."@dbos-inc/eslint-plugin"' package.json)
  echo ${version_with_caret:1}
}

upgrade_directory() {
  directory="$1"
  log "Begin process of upgrading directory '$directory'"

  orig_dir="$PWD"
  cd "$directory"

  previously_installed=$(get_eslint_plugin_version)
  npm i @dbos-inc/eslint-plugin@latest --save-dev
  version_after_install=$(get_eslint_plugin_version)

  if [[ "$previously_installed" = "$version_after_install" ]]; then
    log "No upgrade needed. Already at the latest version."
  else
    log "Upgrade successful. Running linter."
    npm run lint
  fi

  cd "$orig_dir"
}

upgrade_repo() {
  repo_name="$1"
  log "Begin process of upgrading repo '$repo_name'"

  # First, clone the repo if it doesn't exist, or pull the latest changes if it does.
  if [[ -d "$repo_name" ]]; then
    cd "$repo_name"
    git restore . # Removing any changes made
    # git pull # Pulling the latest changes
  else
    git clone "git@github.com:dbos-inc/$repo_name.git"
    cd "$repo_name"
  fi

  ##########

  all_directories=${repos_with_upgradeable_directories[${repo_name}]};

  all_upgrades_skipped=true

  # Then, start upgrading.
  for directory in $all_directories; do
    upgrade_output=$(upgrade_directory "$directory")

    if [[ "$upgrade_output" =~ "Upgrade successful. Running linter." ]]; then
      all_upgrades_skipped=false
    fi

    echo "$upgrade_output"
  done

  if [[ $all_upgrades_skipped = true ]]; then
    log "Skipping PR for repo '$repo_name'."
    cd ..
    return
  fi

  ##########

  orig_dir="$PWD"
  cd "$first_directory"
  version=$(get_eslint_plugin_version)
  cd "$orig_dir"

  branch_name="CaspianA1/dbos_eslint_plugin_upgrade_to_$version"
  git checkout -b "$branch_name"

  git add .
  git commit -m "Upgrade @dbos-inc/eslint-plugin to the latest version, which is $version."
  git push --set-upstream origin "$branch_name"

  log "Finished upgrading '$repo_name'. Making a PR now..."
  open "https://github.com/dbos-inc/$repo_name/pull/new/CaspianA1/$branch_name"

  cd ..
}

####################################################################################################

mkdir -p repos_to_upgrade
cd repos_to_upgrade

for repo_name in "${!repos_with_upgradeable_directories[@]}"; do
  upgrade_repo "$repo_name"
done

####################################################################################################
