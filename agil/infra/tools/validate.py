#!/usr/bin/env python3
"""Structural validator for agil/infra that needs no Helm/cluster/Docker.

Checks:
  * YAML syntax for compose, chart values, Chart.yaml and example configs;
  * Helm templates: balanced Go-template blocks, defined `include` helpers,
    `.Values.*` references that exist in the chart values, required files;
  * Compose semantics: expected services, volume/depends_on references, safe
    port bindings, build contexts that exist;
  * Terraform: required files, `var.*` references declared, balanced braces,
    templatefile placeholders provided by the caller;
  * shell scripts: `bash -n` when bash is available;
  * relative Markdown links resolve (infra docs + the two core deployment docs);
  * obvious committed secrets (private keys, AWS keys, filled .env.example).

Usage:
    python3 agil/infra/tools/validate.py
    python3 agil/infra/tools/validate.py --quiet

Exit code 0 = no errors (warnings allowed), 1 = errors found.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    print("PyYAML is required: python3 -m pip install pyyaml", file=sys.stderr)
    raise SystemExit(2)


def _compose_tag_constructor(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node):
    """Compose's YAML tags (!reset, !override) are not plain YAML.

    They appear in the remote-node override; treat them as the value they carry
    so the structural checks can parse the file.
    """
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    return loader.construct_scalar(node)


yaml.SafeLoader.add_multi_constructor("!", _compose_tag_constructor)

REPO = Path(__file__).resolve().parents[3]
INFRA = REPO / "agil" / "infra"
CORE_DOCS = [
    REPO / "agil" / "core" / "docs" / "deployment.md",
    REPO / "agil" / "core" / "docs" / "deployment-quickstart.md",
]

ERRORS: list[str] = []
WARNINGS: list[str] = []


def error(message: str) -> None:
    ERRORS.append(message)


def warn(message: str) -> None:
    WARNINGS.append(message)


def rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------- YAML

def check_yaml() -> None:
    paths = sorted([*INFRA.rglob("*.yml"), *INFRA.rglob("*.yaml")])
    for path in paths:
        if "templates" in path.parts and "helm" in path.parts:
            continue
        try:
            docs = list(yaml.safe_load_all(read(path)))
        except Exception as exc:  # noqa: BLE001
            error(f"{rel(path)}: YAML parse error: {exc}")
            continue
        if not docs or all(doc is None for doc in docs):
            warn(f"{rel(path)}: empty YAML document")
    print(f"  YAML files parsed: {len(paths)}")


# -------------------------------------------------------------------- Helm

BLOCK_OPEN = re.compile(r"{{-?\s*(if|range|with|define|block)\b")
BLOCK_END = re.compile(r"{{-?\s*end\s*-?}}")
VALUE_REF = re.compile(r"\.Values((?:\.[A-Za-z0-9_]+)+)")
INCLUDE_REF = re.compile(r'include\s+"([^"]+)"')
DEFINE_REF = re.compile(r'define\s+"([^"]+)"')


def value_exists(values: dict, dotted: str) -> bool:
    node = values
    for part in dotted.strip(".").split("."):
        if not isinstance(node, dict) or part not in node:
            return False
        node = node[part]
    return True


def check_helm() -> None:
    charts = sorted((INFRA / "helm").glob("*/Chart.yaml"))
    if not charts:
        error("no Helm charts found under agil/infra/helm")
        return
    for chart_yaml in charts:
        chart_dir = chart_yaml.parent
        name = chart_dir.name
        required = ["Chart.yaml", "values.yaml", "templates/deployment.yaml"]
        if name == "agil-core":
            required.append("templates/service.yaml")
        for required_file in required:
            if not (chart_dir / required_file).is_file():
                error(f"{rel(chart_dir)}: missing {required_file}")
        try:
            chart = yaml.safe_load(read(chart_yaml))
            values = yaml.safe_load(read(chart_dir / "values.yaml")) or {}
        except Exception as exc:  # noqa: BLE001
            error(f"{rel(chart_yaml)}: {exc}")
            continue
        for field in ["apiVersion", "name", "version", "appVersion"]:
            if field not in chart:
                error(f"{rel(chart_yaml)}: missing {field}")
        if chart.get("apiVersion") != "v2":
            error(f"{rel(chart_yaml)}: apiVersion must be v2 (Helm 3)")
        if chart.get("name") != name:
            warn(f"{rel(chart_yaml)}: chart name '{chart.get('name')}' differs from directory '{name}'")

        templates = sorted((chart_dir / "templates").glob("*"))
        defines: set[str] = set()
        for template in templates:
            if template.is_file():
                for match in DEFINE_REF.finditer(read(template)):
                    defines.add(match.group(1))

        for template in templates:
            if not template.is_file() or template.suffix not in (".yaml", ".yml", ".tpl", ".txt"):
                continue
            text = read(template)
            opens = len(BLOCK_OPEN.findall(text))
            ends = len(BLOCK_END.findall(text))
            if opens != ends:
                error(f"{rel(template)}: unbalanced Go template blocks ({opens} open vs {ends} end)")
            for match in VALUE_REF.finditer(text):
                if not value_exists(values, match.group(1)):
                    error(f"{rel(template)}: .Values{match.group(1)} is not defined in values.yaml")
            for match in INCLUDE_REF.finditer(text):
                include = match.group(1)
                if include not in defines and not include.startswith("agil-") and "." not in include:
                    warn(f"{rel(template)}: include \"{include}\" is not defined in this chart")
                elif include not in defines:
                    error(f"{rel(template)}: include \"{include}\" has no define")
            if re.search(r"\b(and|or)\s+\(?\s*\.Values", text) and "not " not in text:
                # heuristic only; no action, kept for future rules
                pass

        # A Secret/data key should never carry a literal 'CHANGE_ME' default.
        for path in chart_dir.rglob("*.yaml"):
            if "templates" in path.parts:
                continue
            if re.search(r"(?i)\b(CHANGE_ME|changeme|password\s*:\s*['\"]?[A-Za-z0-9]{6,})", read(path)):
                warn(f"{rel(path)}: looks like it may contain a placeholder or secret")
        print(f"  chart {name}: {len(templates)} templates, {len(defines)} helpers")


# ----------------------------------------------------------------- Compose

# The relay range must be identity-mapped: the same TURN_MIN_PORT/TURN_MAX_PORT
# variables on the host side, container side and coturn command (P2-2).
TURN_RANGE_PORT = re.compile(
    r"^\$\{TURN_BIND_ADDR:-[^}]+\}:"
    r"\$\{TURN_MIN_PORT:-(\d+)\}-\$\{TURN_MAX_PORT:-(\d+)\}:"
    r"\$\{TURN_MIN_PORT:-(\d+)\}-\$\{TURN_MAX_PORT:-(\d+)\}/udp$"
)
TURN_SIGNAL_PORT = re.compile(
    r"^\$\{TURN_BIND_ADDR:-[^}]+\}:\$\{TURN_PORT:-(\d+)\}:\$\{TURN_PORT:-(\d+)\}/(udp|tcp)$"
)
CORE_FORBIDDEN_ENV = ("TURN_PASSWORD", "TURN_USER", "TURN_REALM", "TURN_EXTERNAL_IP",
                      "TURN_MIN_PORT", "TURN_MAX_PORT", "TURN_BIND_ADDR",
                      "AGIL_NODE_TOKEN", "AGIL_NODE_KEY")


def check_compose() -> None:
    compose_path = INFRA / "quickstart" / "docker-compose.yml"
    if not compose_path.is_file():
        error(f"{rel(compose_path)}: missing")
        return
    try:
        compose = yaml.safe_load(read(compose_path)) or {}
    except Exception as exc:  # noqa: BLE001
        error(f"{rel(compose_path)}: {exc}")
        return

    # The project is split into includes; validate the merged service model.
    services: dict = {}
    declared_volumes: set[str] = set(compose.get("volumes") or {})
    includes = compose.get("include") or []
    if isinstance(includes, str):
        includes = [includes]
    included = 0
    for entry in includes:
        rel_path = entry if isinstance(entry, str) else str((entry or {}).get("path", ""))
        inc_path = (compose_path.parent / rel_path).resolve()
        if not inc_path.is_file():
            error(f"{rel(compose_path)}: include '{rel_path}' does not exist")
            continue
        included += 1
        try:
            inc = yaml.safe_load(read(inc_path)) or {}
        except Exception as exc:  # noqa: BLE001
            error(f"{rel(inc_path)}: YAML parse error: {exc}")
            continue
        services.update(inc.get("services") or {})
        declared_volumes |= set(inc.get("volumes") or {})
    services.update(compose.get("services") or {})
    declared_volumes |= set(compose.get("volumes") or {})
    if included < 2:
        error(f"{rel(compose_path)}: expected includes for the core and node bundles")

    for expected in ["core", "node", "turn", "redis"]:
        if expected not in services:
            error(f"{rel(compose_path)}: service '{expected}' is missing from the project")
    for service_name, service in services.items():
        service = service or {}
        if "privileged" in service and service["privileged"]:
            error(f"{rel(compose_path)}: service '{service_name}' is privileged")
        depends = service.get("depends_on") or {}
        names = depends.keys() if isinstance(depends, dict) else depends
        for dependency in names:
            if dependency not in services:
                error(f"{rel(compose_path)}: service '{service_name}' depends on unknown '{dependency}'")
        for volume in service.get("volumes") or []:
            if isinstance(volume, str) and ":" in volume:
                source = volume.split(":", 1)[0]
                if not source.startswith((".", "/", "~")) and source not in declared_volumes:
                    error(f"{rel(compose_path)}: service '{service_name}' uses undeclared volume '{source}'")
        build = service.get("build")
        context = build.get("context") if isinstance(build, dict) else build
        if context:
            resolved = (compose_path.parent / context).resolve()
            if not resolved.exists():
                error(f"{rel(compose_path)}: build context '{context}' does not exist")
        for port in service.get("ports") or []:
            if not isinstance(port, str):
                continue
            host = port.rsplit(":", 1)[0]
            if "8787" in port and host.startswith(("0.0.0.0", ":")):
                warn(f"{rel(compose_path)}: core port is published on all interfaces: {port}")

    # P2-1: core is internet-facing; it must not receive node/TURN secrets.
    core = services.get("core") or {}
    if core.get("env_file"):
        error(f"{rel(compose_path)}: core must not use env_file (P2-1: it leaks TURN/node secrets); use an explicit environment list")
    core_env = core.get("environment") or {}
    if not core_env:
        error(f"{rel(compose_path)}: core has no explicit environment")
    for forbidden in CORE_FORBIDDEN_ENV:
        if forbidden in core_env:
            error(f"{rel(compose_path)}: core environment contains unrelated secret '{forbidden}' (P2-1)")
    for required in ("AGIL_TOKEN_SECRET", "AGIL_API_KEYS", "AGIL_IP_SALT", "AGIL_ICE_SERVERS"):
        if required not in core_env:
            error(f"{rel(compose_path)}: core is missing required environment '{required}'")

    # P2-4: node core URL must be overridable, and the remote-node override must
    # remove the local-core dependency and require AGIL_CORE_URL.
    node = services.get("node") or {}
    node_env = node.get("environment") or {}
    core_url = str(node_env.get("AGIL_CORE_URL", ""))
    if "AGIL_CORE_URL" not in core_url:
        error(f"{rel(compose_path)}: node AGIL_CORE_URL must be overridable via ${{AGIL_CORE_URL:-...}} (P2-4)")
    remote_path = compose_path.parent / "docker-compose.node-remote.yml"
    if not remote_path.is_file():
        error(f"{rel(remote_path)}: missing remote-node override (P2-4)")
    else:
        try:
            remote = yaml.safe_load(read(remote_path)) or {}
        except Exception as exc:  # noqa: BLE001
            error(f"{rel(remote_path)}: YAML parse error: {exc}")
            remote = {}
        remote_node = (remote.get("services") or {}).get("node") or {}
        if remote_node.get("depends_on", "missing") != []:
            error(f"{rel(remote_path)}: must reset the local core dependency with 'depends_on: !reset []' (P2-4)")
        remote_env = remote_node.get("environment") or {}
        remote_core_url = str(remote_env.get("AGIL_CORE_URL", ""))
        if ":?" not in remote_core_url:
            error(f"{rel(remote_path)}: AGIL_CORE_URL must be required with ${{AGIL_CORE_URL:?...}} (P2-4)")

    # P2-2: TURN host/container/coturn ranges must be identical.
    turn = services.get("turn") or {}
    range_ports = []
    signal_ports = 0
    for port in turn.get("ports") or []:
        if not isinstance(port, str):
            continue
        match = TURN_RANGE_PORT.fullmatch(port)
        if match:
            host_min, host_max, cont_min, cont_max = match.groups()
            if (host_min, host_max) != (cont_min, cont_max):
                error(f"{rel(compose_path)}: TURN relay mapping shifts ports ({port}); host and container ranges must match (P2-2)")
            range_ports.append((host_min, host_max))
            continue
        match = TURN_SIGNAL_PORT.fullmatch(port)
        if match:
            signal_ports += 1
            if match.group(1) != match.group(2):
                error(f"{rel(compose_path)}: TURN listening port mapping shifts ports ({port}) (P2-2)")
            continue
        error(f"{rel(compose_path)}: unexpected TURN port mapping '{port}'; keep the ${TURN_*-...} identity mapping (P2-2)")
    if not range_ports:
        error(f"{rel(compose_path)}: TURN relay range port is missing (P2-2)")
    if signal_ports < 2:
        error(f"{rel(compose_path)}: TURN needs TCP and UDP listener mappings (P2-2)")
    turn_command = [str(arg) for arg in (turn.get("command") or [])]
    for option in ("--min-port=${TURN_MIN_PORT:-", "--max-port=${TURN_MAX_PORT:-",
                   "--listening-port=${TURN_PORT:-"):
        if not any(arg.startswith(option) for arg in turn_command):
            error(f"{rel(compose_path)}: coturn command must use {option}... so the range matches the mapping (P2-2)")
    if not turn.get("healthcheck"):
        error(f"{rel(compose_path)}: TURN has no healthcheck (P3-2)")
    if "ALL" not in (turn.get("cap_drop") or []):
        error(f"{rel(compose_path)}: TURN must drop all capabilities (P3-2)")

    env_example = INFRA / "quickstart" / ".env.example"
    if not env_example.is_file():
        error(f"{rel(env_example)}: missing")
    else:
        text = read(env_example)
        for name in ["AGIL_PUBLIC_ORIGIN", "AGIL_TOKEN_SECRET", "AGIL_API_KEYS", "AGIL_IP_SALT",
                     "AGIL_ICE_SERVERS", "TURN_PASSWORD", "AGIL_NODE_TOKEN",
                     "TURN_ALLOW_PRIVATE_IP", "TURN_TOTAL_QUOTA"]:
            if not re.search(rf"^{name}=", text, re.MULTILINE):
                error(f"{rel(env_example)}: missing {name}")
        for name in ["AGIL_TOKEN_SECRET", "AGIL_API_KEYS", "AGIL_IP_SALT", "TURN_PASSWORD"]:
            match = re.search(rf"^{name}=(.*)$", text, re.MULTILINE)
            if match and match.group(1).strip():
                error(f"{rel(env_example)}: {name} must be empty in the example")

    # A node/TURN host must never need (or carry) the core secrets (P2-4).
    node_env_example = INFRA / "quickstart" / "node.env.example"
    if not node_env_example.is_file():
        error(f"{rel(node_env_example)}: missing")
    else:
        text = read(node_env_example)
        for name in ["AGIL_CORE_URL", "AGIL_NODE_TOKEN", "TURN_PASSWORD"]:
            if not re.search(rf"^{name}=", text, re.MULTILINE):
                error(f"{rel(node_env_example)}: missing {name}")
        for name in ["AGIL_TOKEN_SECRET", "AGIL_API_KEYS", "AGIL_IP_SALT"]:
            if re.search(rf"^{name}=", text, re.MULTILINE):
                error(f"{rel(node_env_example)}: must not contain core secret {name}")
    print(f"  compose services: {', '.join(sorted(services))} (from {included} include files)")


# --------------------------------------------------------------- Terraform

def strip_hcl_strings(text: str) -> str:
    # Strings first: URLs contain "//" and would otherwise start a comment.
    text = re.sub(r'"(?:[^"\\]|\\.)*"', '""', text)
    text = re.sub(r"#.*", "", text)
    text = re.sub(r"//.*", "", text)
    return text


def check_terraform() -> None:
    tf_dir = INFRA / "terraform" / "aws"
    if not tf_dir.is_dir():
        error("agil/infra/terraform/aws is missing")
        return
    tf_files = sorted(tf_dir.glob("*.tf"))
    declared_vars = set()
    text_by_file = {}
    for path in tf_files:
        text = read(path)
        text_by_file[path] = text
        for match in re.finditer(r'variable\s+"([^"]+)"', text):
            declared_vars.add(match.group(1))
        stripped = strip_hcl_strings(text)
        if stripped.count("{") != stripped.count("}"):
            error(f"{rel(path)}: unbalanced braces")
        if stripped.count("[") != stripped.count("]"):
            error(f"{rel(path)}: unbalanced brackets")
    for path, text in text_by_file.items():
        for match in re.finditer(r"\bvar\.([A-Za-z0-9_]+)", text):
            if match.group(1) not in declared_vars:
                error(f"{rel(path)}: var.{match.group(1)} is not declared in variables.tf")
    for required in ["versions.tf", "variables.tf", "network.tf", "security.tf", "compute.tf", "iam.tf", "dns.tf", "outputs.tf", "user_data.sh.tftpl"]:
        if not (tf_dir / required).is_file():
            error(f"{rel(tf_dir)}: missing {required}")

    # Guardrails that must not silently regress with a future edit.
    variables_text = read(tf_dir / "variables.tf")
    for name in ("allow_world_admin", "enable_ssm", "enable_turn_tls"):
        if not re.search(rf'variable\s+"{name}"', variables_text):
            error(f"{rel(tf_dir / 'variables.tf')}: missing variable \"{name}\"")
    if not re.search(r'variable\s+"admin_cidr".*?var\.allow_world_admin', variables_text, re.DOTALL):
        error(f"{rel(tf_dir / 'variables.tf')}: admin_cidr validation must honour allow_world_admin (P2-5)")
    iam_text = read(tf_dir / "iam.tf")
    if "AmazonSSMManagedInstanceCore" not in iam_text or "aws_iam_instance_profile" not in iam_text:
        error(f"{rel(tf_dir / 'iam.tf')}: expected an SSM role and instance profile (P2-6)")
    for path in (tf_dir / "compute.tf",):
        if "iam_instance_profile" not in read(path):
            error(f"{rel(path)}: instances must attach the SSM instance profile (P2-6)")
    security_text = read(tf_dir / "security.tf")
    tls_rule = re.search(r'resource\s+"aws_vpc_security_group_ingress_rule"\s+"node_turn_tls"\s*\{(.*?)\n\}', security_text, re.DOTALL)
    if not tls_rule or "enable_turn_tls" not in tls_rule.group(1):
        error(f"{rel(tf_dir / 'security.tf')}: 5349/TLS rule must be gated by enable_turn_tls (P3-8)")
    outputs_text = read(tf_dir / "outputs.tf")
    for name in ("core_api_url", "core_private_url", "ssm_session_commands"):
        if not re.search(rf'output\s+"{name}"', outputs_text):
            error(f"{rel(tf_dir / 'outputs.tf')}: missing output \"{name}\" (P2-4/P2-6)")

    user_data = tf_dir / "user_data.sh.tftpl"
    if user_data.is_file():
        template = read(user_data)
        placeholders = set(re.findall(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", template))
        # Terraform's own directives are not template variables here.
        placeholders -= {"path", "module"}
        provided: set[str] = set()
        for path, text in text_by_file.items():
            for match in re.finditer(r"templatefile\([^,]+,\s*\{(.*?)\}\s*\)", text, re.DOTALL):
                provided |= set(re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*=", match.group(1)))
        missing = placeholders - provided
        if missing:
            error(f"{rel(user_data)}: placeholders not provided by templatefile: {', '.join(sorted(missing))}")
        extra = provided - placeholders
        if extra:
            warn(f"{rel(user_data)}: unused templatefile values: {', '.join(sorted(extra))}")

    for path in tf_dir.glob("*.tf"):
        text = read(path)
        if re.search(r'access_key\s*=\s*"[^"]+"', text) or re.search(r'secret_key\s*=\s*"[^"]+"', text):
            error(f"{rel(path)}: hard-coded AWS credentials")
    print(f"  terraform: {len(tf_files)} files, {len(declared_vars)} variables")


# -------------------------------------------------------------------- shell

def find_bash() -> str | None:
    """Prefer Git Bash on Windows: System32\\bash.exe is WSL, not a POSIX shell."""
    candidates: list[Path] = []
    if os.name == "nt":
        candidates.append(Path(r"C:\Program Files\Git\bin\bash.exe"))
    found = shutil.which("bash")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def check_shell() -> None:
    scripts = sorted((INFRA / "quickstart").glob("*.sh"))
    net_lib = INFRA / "quickstart" / "lib" / "net.sh"
    if net_lib.is_file():
        scripts.append(net_lib)
    node_loop = INFRA / "node" / "node-loop.sh"
    if node_loop.is_file():
        scripts.append(node_loop)
    node_health = INFRA / "node" / "node-healthcheck.sh"
    if node_health.is_file():
        scripts.append(node_health)
    test_net = INFRA / "tools" / "test-net.sh"
    if test_net.is_file():
        scripts.append(test_net)
    helm_loop = INFRA / "helm" / "agil-node" / "files" / "node-loop.sh"
    if node_loop.is_file() and helm_loop.is_file() and read(node_loop) != read(helm_loop):
        error(f"{rel(helm_loop)}: out of sync with {rel(node_loop)}")
    bash = find_bash()
    for script in scripts:
        if bash:
            # Pass a repository-relative path: Git Bash on Windows mangles
            # `E:\...` into `E:...` when the argument is absolute.
            relative = str(script.relative_to(REPO)).replace("\\", "/")
            result = subprocess.run([bash, "-n", str(relative)], cwd=REPO, capture_output=True, text=True, check=False)
            if result.returncode != 0:
                error(f"{rel(script)}: bash -n failed: {result.stderr.strip()}")
        first_line = script.read_text(encoding="utf-8").splitlines()[0] if script.stat().st_size else ""
        if not (first_line.startswith("#!/usr/bin/env bash") or first_line.startswith("#!/bin/sh") or first_line.startswith("#!/usr/bin/env sh")):
            warn(f"{rel(script)}: missing a bash/sh shebang")

    # P2-3 regression tests: TURN_EXTERNAL_IP classification must stay correct.
    if bash and test_net.is_file():
        relative = str(test_net.relative_to(REPO)).replace("\\", "/")
        result = subprocess.run([bash, relative], cwd=REPO, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            error(f"{rel(test_net)}: classifier tests failed: {result.stdout.strip() or result.stderr.strip()}")
    print(f"  shell scripts checked: {len(scripts)}{'' if bash else ' (bash not found; only shebang checked)'}")


# ------------------------------------------------------------------- links

def check_markdown() -> None:
    markdown = [*INFRA.rglob("*.md"), *[path for path in CORE_DOCS if path.exists()]]
    link_re = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
    count = 0
    for path in markdown:
        text = read(path)
        for match in link_re.finditer(text):
            target = match.group(1).strip()
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target = target.split("#", 1)[0].strip()
            if not target or target.startswith("<") or "{{" in target or "..." in target:
                continue
            resolved = (path.parent / target).resolve()
            count += 1
            if not resolved.exists():
                error(f"{rel(path)}: broken relative link: {target}")
    print(f"  markdown links checked: {count}")


# ----------------------------------------------------------------- secrets

SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "private key"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key id"),
    (re.compile(r"\bghp_[A-Za-z0-9]{30,}\b"), "GitHub token"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "Slack token"),
]


def check_secrets() -> None:
    files = [path for path in INFRA.rglob("*") if path.is_file() and path.suffix in (".yaml", ".yml", ".tf", ".sh", ".md", ".example", ".env", ".tftpl", ".mjs")]
    for path in files:
        text = read(path)
        for pattern, label in SECRET_PATTERNS:
            if pattern.search(text):
                error(f"{rel(path)}: possible committed secret ({label})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true", help="only print errors/warnings")
    args = parser.parse_args()

    print("AGIL infra structural validation")
    check_yaml()
    check_helm()
    check_compose()
    check_terraform()
    check_shell()
    check_markdown()
    check_secrets()

    if WARNINGS and not args.quiet:
        print(f"\nWarnings ({len(WARNINGS)}):")
        for item in WARNINGS:
            print(f"  ! {item}")
    if ERRORS:
        print(f"\nErrors ({len(ERRORS)}):")
        for item in ERRORS:
            print(f"  x {item}")
        return 1
    print(f"\nOK: no errors, {len(WARNINGS)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
