#!/usr/bin/env bash
set -euo pipefail

AUTO_YES=false

for arg in "$@"; do
  case "$arg" in
    --yes|-y)
      AUTO_YES=true
      ;;
    -h|--help)
      echo "用法: $0 [--yes|-y]"
      echo "  --yes      跳过交互确认，直接执行"
      exit 0
      ;;
    *)
      echo "未知参数: $arg" >&2
      echo "用法: $0 [--yes|-y]" >&2
      exit 1
      ;;
  esac
done

echo "清理 Claude 应用、CLI 配置/缓存、native installer 版本文件、npm 残留，以及 macOS Keychain 登录信息（危险操作）"

HOME_DIR="${HOME:-$PWD}"
CURRENT_USER="${USER:-$(id -un)}"
DEFAULT_CONFIG_HOME="${HOME_DIR}/.claude"
CONFIG_HOME="${OPENCLAUDE_CONFIG_DIR:-${DEFAULT_CONFIG_HOME}}"
CUSTOM_CONFIG_HOME="${OPENCLAUDE_CONFIG_DIR:-}"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
XDG_DATA_HOME="${XDG_DATA_HOME:-${HOME_DIR}/.local/share}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-${HOME_DIR}/.cache}"
XDG_STATE_HOME="${XDG_STATE_HOME:-${HOME_DIR}/.local/state}"
USER_BIN_DIR="${HOME_DIR}/.local/bin"

oauth_suffixes=("" "-staging-oauth" "-local-oauth" "-custom-oauth")
service_suffixes=("" "-credentials")

sha256_short() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print substr($1, 1, 8)}'
    return
  fi

  if command -v openssl >/dev/null 2>&1; then
    printf '%s' "$1" | openssl dgst -sha256 | awk '{print substr($NF, 1, 8)}'
    return
  fi

  return 1
}

needs_sudo_for_path() {
  local p="$1"
  [[ "$p" == /Applications/* ]] || [[ "$p" == /Library/* ]] || [[ "$p" == /usr/local/* ]] || [[ "$p" == /opt/homebrew/* ]]
}

remove_path() {
  local p="$1"
  if [[ ! -e "$p" ]]; then
    echo "不存在：$p"
    return
  fi

  if needs_sudo_for_path "$p"; then
    echo "删除（需要 sudo）：$p"
    sudo rm -rf "$p"
  else
    echo "删除：$p"
    rm -rf "$p"
  fi
}

cleanup_shell_alias_in_file() {
  local file="$1"
  local temp_file="$2"
  local removed=false

  [[ -f "$file" ]] || return 0

  : > "$temp_file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" =~ ^[[:space:]]*alias[[:space:]]+claude[[:space:]]*= ]] &&
       [[ "$line" == *"${HOME_DIR}/.claude/local/claude"* ||
          "$line" == *"~/.claude/local/claude"* ]]; then
      removed=true
      continue
    fi
    printf '%s\n' "$line" >> "$temp_file"
  done < "$file"

  if [[ "$removed" == true ]]; then
    mv "$temp_file" "$file"
    echo "已清理 shell alias：$file"
  fi

  [[ -f "$temp_file" ]] && rm -f "$temp_file"
}

# 固定要清理的路径（有的可能不存在）
paths=(
  "/Applications/Claude.app"
  "${DEFAULT_CONFIG_HOME}"
  "$HOME_DIR/Library/Application Support/Claude"
  "$HOME_DIR/Library/Caches/com.anthropic.claude"
  "$HOME_DIR/Library/Caches/Claude"
  "$HOME_DIR/Library/Application Support/claude-cli-nodejs"
  "$HOME_DIR/Library/Preferences/claude-cli-nodejs"
  "$HOME_DIR/Library/Caches/claude-cli-nodejs"
  "$HOME_DIR/Library/Logs/claude-cli-nodejs"
  "$HOME_DIR/Library/Saved Application State/com.anthropic.claude.savedState"
  "$HOME_DIR/Library/Preferences/com.anthropic.claude.plist"
  "$HOME_DIR/Library/Logs/Claude"
  "${TMP_BASE}/claude-cli-nodejs"
  "${USER_BIN_DIR}/claude"
  "${XDG_DATA_HOME}/claude"
  "${XDG_CACHE_HOME}/claude"
  "${XDG_STATE_HOME}/claude"
  "/usr/local/bin/claude"
  "/opt/homebrew/bin/claude"
)

# 如果使用了自定义 OPENCLAUDE_CONFIG_DIR，也一并清理对应目录
if [[ "${CONFIG_HOME}" != "${DEFAULT_CONFIG_HOME}" ]]; then
  paths+=( "${CONFIG_HOME}" )
fi

# 全局配置文件会随 OAuth 环境切换产生不同后缀
config_roots=( "${CONFIG_HOME}" )

for root in "${config_roots[@]}"; do
  for oauth_suffix in "${oauth_suffixes[@]}"; do
    paths+=( "${root}${oauth_suffix}.json" )
    paths+=( "${root}/.config${oauth_suffix}.json" )
  done
done

# 查找各配置根目录下的配置备份文件
backup_files=()
backup_search_roots=( "${CONFIG_HOME}" )

backup_patterns=(".config.json.backup*")
for oauth_suffix in "${oauth_suffixes[@]}"; do
  backup_patterns+=( ".config${oauth_suffix}.json.backup*" )
done

for search_root in "${backup_search_roots[@]}"; do
  [[ -d "${search_root}" ]] || continue
  for pattern in "${backup_patterns[@]}"; do
    while IFS= read -r -d '' f; do
      backup_files+=( "$f" )
    done < <(find "${search_root}" -maxdepth 1 -type f -name "${pattern}" -print0 2>/dev/null || true)
  done
done

if ((${#backup_files[@]} > 0)); then
  paths+=( "${backup_files[@]}" )
fi

# npm 全局安装残留（可能需要 sudo）
if command -v npm >/dev/null 2>&1; then
  if npm_prefix="$(npm config get prefix 2>/dev/null)"; then
    npm_prefix="${npm_prefix%/}"
    if [[ -n "$npm_prefix" ]]; then
      paths+=( "${npm_prefix}/bin/claude" )
      paths+=( "${npm_prefix}/lib/node_modules/@anthropic-ai/claude-code" )
      paths+=( "${npm_prefix}/lib/node_modules/@anthropic-ai/Codex" )
      paths+=( "${npm_prefix}/node_modules/@anthropic-ai/claude-code" )
      paths+=( "${npm_prefix}/node_modules/@anthropic-ai/Codex" )
    fi
  fi
fi

# Keychain 中 Claude 相关的服务名。
# macOS 默认 OAuth 凭据保存在 "Claude-credentials"。
keychain_services=()

for oauth_suffix in "${oauth_suffixes[@]}"; do
  for service_suffix in "${service_suffixes[@]}"; do
    keychain_services+=( "Claude Code${oauth_suffix}${service_suffix}" )
  done
done

if [[ -n "${CUSTOM_CONFIG_HOME}" ]]; then
  if dir_hash="$(sha256_short "${CUSTOM_CONFIG_HOME}")"; then
    for oauth_suffix in "${oauth_suffixes[@]}"; do
      for service_suffix in "${service_suffixes[@]}"; do
        keychain_services+=( "Claude Code${oauth_suffix}${service_suffix}-${dir_hash}" )
      done
    done
  else
    echo "警告：无法计算配置目录对应的 Keychain hash，将只清理默认服务名。"
  fi
fi

# 去重
paths_uniq=()
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  paths_uniq+=( "$p" )
done < <(printf '%s\n' "${paths[@]}" | sort -u)
paths=( "${paths_uniq[@]}" )

keychain_services_uniq=()
while IFS= read -r service; do
  [[ -z "$service" ]] && continue
  keychain_services_uniq+=( "$service" )
done < <(printf '%s\n' "${keychain_services[@]}" | sort -u)
keychain_services=( "${keychain_services_uniq[@]}" )

shell_config_files=(
  "${ZDOTDIR:-${HOME_DIR}}/.zshrc"
  "${HOME_DIR}/.bashrc"
  "${HOME_DIR}/.config/fish/config.fish"
)

echo "将删除以下路径（若存在）："
for p in "${paths[@]}"; do
  echo "  $p"
done

echo
echo "将清理以下 shell 配置中的安装器 alias（若存在）："
for shell_file in "${shell_config_files[@]}"; do
  echo "  $shell_file"
done

echo
echo "将删除以下 Keychain 条目（若存在，用户：${CURRENT_USER}）："
for service in "${keychain_services[@]}"; do
  echo "  $service"
done

if ((${#backup_files[@]} == 0)); then
  echo "未发现配置备份文件（*.backup*）。"
fi

if [[ "$AUTO_YES" == false ]]; then
  read -r -p "输入 YES 并回车以继续删除（其他任意内容为取消）: " confirm < /dev/tty
  if [[ "$confirm" != "YES" ]]; then
    echo "已取消，不执行任何删除操作。"
    exit 0
  fi
fi

echo "开始处理..."

for p in "${paths[@]}"; do
  remove_path "$p"
done

echo
echo "开始清理 shell alias..."
for shell_file in "${shell_config_files[@]}"; do
  cleanup_shell_alias_in_file "$shell_file" "${TMP_BASE}/claude-clear-alias.$$.$(basename "$shell_file").tmp"
done

echo
echo "开始清理 Keychain 登录信息..."

for service in "${keychain_services[@]}"; do
  if security find-generic-password -a "${CURRENT_USER}" -s "${service}" >/dev/null 2>&1; then
    echo "删除 Keychain 项：${service}"
    if ! security delete-generic-password -a "${CURRENT_USER}" -s "${service}" >/dev/null 2>&1; then
      echo "删除失败：${service}"
    fi
  else
    echo "Keychain 不存在：${service}"
  fi
done

echo "清理完成。"
