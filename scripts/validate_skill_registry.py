#!/usr/bin/env python3
"""Validate local metadata, pinned provenance and license bytes without a network call."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys

PRESETS = {"sales-growth", "full-stack-engineer", "content-media", "research-qa", "operations-coordinator", "product-ux", "security-privacy", "data-insights", "customer-success", "finance-planning"}
LICENSES = {"MIT", "Apache-2.0"}


def schema_errors(value, schema, location="$"):
    errors = []
    if "oneOf" in schema:
        valid = sum(not schema_errors(value, candidate, location) for candidate in schema["oneOf"])
        return [] if valid == 1 else [f"{location}: expected exactly one supported shape"]
    kind = schema.get("type")
    matches = {"object": isinstance(value, dict), "array": isinstance(value, list), "string": isinstance(value, str), "integer": isinstance(value, int) and not isinstance(value, bool), "boolean": isinstance(value, bool), "null": value is None}
    if kind and not matches.get(kind, False):
        return [f"{location}: expected {kind}"]
    if "const" in schema and (type(value) is not type(schema["const"]) or value != schema["const"]):
        errors.append(f"{location}: invalid constant")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{location}: unsupported value")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{location}.{key}: required")
        for key, child in value.items():
            if key in properties:
                errors += schema_errors(child, properties[key], f"{location}.{key}")
            elif schema.get("additionalProperties") is False:
                errors.append(f"{location}.{key}: unexpected field")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", sys.maxsize):
            errors.append(f"{location}: invalid item count")
        if schema.get("uniqueItems") and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            errors.append(f"{location}: duplicate items")
        for i, child in enumerate(value):
            errors += schema_errors(child, schema.get("items", {}), f"{location}[{i}]")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", sys.maxsize):
            errors.append(f"{location}: invalid length")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{location}: invalid format")
    if isinstance(value, int) and not isinstance(value, bool):
        if value < schema.get("minimum", -sys.maxsize) or value > schema.get("maximum", sys.maxsize):
            errors.append(f"{location}: out of range")
    return errors


def validate(root: Path, catalog=None) -> list[str]:
    registry = (Path(root) / "packages/skills").resolve()
    errors = []
    try:
        catalog = catalog if catalog is not None else json.loads((registry / "catalog.json").read_text())
        lock = json.loads((registry / "sources.lock.json").read_text())
        for name, value in [("catalog", catalog), ("sources", lock)]:
            schema = json.loads((registry / "schemas" / f"{name}.schema.json").read_text())
            errors += schema_errors(value, schema, name)
        configuration_schema = json.loads((registry / "schemas/configuration.schema.json").read_text())
        if configuration_schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
            errors.append("Unsupported configuration schema")
    except (OSError, ValueError, TypeError) as exc:
        return [f"Registry metadata unavailable: {type(exc).__name__}"]
    if errors:
        return errors

    def local(relative: str):
        candidate = PurePosixPath(relative)
        if candidate.is_absolute() or ".." in candidate.parts or "\\" in relative or not candidate.parts:
            raise ValueError("unsafe local path")
        full = (registry / relative).resolve(strict=True)
        if not full.is_relative_to(registry) or not full.is_file():
            raise ValueError("local path escaped the registry")
        return full

    def verify(relative, expected):
        try:
            if hashlib.sha256(local(relative).read_bytes()).hexdigest() != expected:
                errors.append(f"Checksum mismatch: {relative}")
        except (OSError, ValueError, TypeError):
            errors.append(f"Missing or unsafe file: {relative}")

    sources = {s["id"]: s for s in lock["sources"]}
    if len(sources) != len(lock["sources"]):
        errors.append("Duplicate source identifiers")
    locked_files = {}
    for source in lock["sources"]:
        if source["license"] not in LICENSES or not re.fullmatch(r"[a-f0-9]{40}", source["commit"]):
            errors.append(f"Unverified source: {source['id']}")
        for upstream in source["files"]:
            verify(upstream["bundled_path"], upstream["sha256"])
            verify(upstream["bundled_license_path"], upstream["license_sha256"])
            # One pinned upstream workflow may legitimately feed several adapters.
            # Each local reference must still have an unambiguous, verified mapping.
            reference = (upstream["path"], upstream["bundled_path"])
            source_files = locked_files.setdefault(source["id"], {})
            if reference in source_files:
                errors.append(f"Duplicate upstream reference: {source['id']}/{upstream['path']}")
            if any(item["path"] == upstream["path"] and
                   (item["sha256"], item["license_sha256"]) !=
                   (upstream["sha256"], upstream["license_sha256"])
                   for item in source_files.values()):
                errors.append(f"Conflicting pinned bytes: {source['id']}/{upstream['path']}")
            source_files[reference] = upstream
            try:
                text = local(upstream["bundled_license_path"]).read_text()
                markers = ("Permission is hereby granted", "MIT License") if source["license"] == "MIT" else ("Apache License", "Version 2.0")
                if not all(marker in text for marker in markers):
                    errors.append(f"License text mismatch: {source['id']}/{upstream['license_path']}")
            except (OSError, ValueError):
                pass  # Already reported by verify().
    skill_ids = {s["id"] for s in catalog["skills"]}
    if len(skill_ids) != len(catalog["skills"]):
        errors.append("Duplicate skill identifiers")
    if {p["id"] for p in catalog["presets"]} != PRESETS:
        errors.append("The ten optional starter presets must be present exactly once")
    for section, folder_name in [("skills", "bundles"), ("presets", "presets")]:
        for entry in catalog[section]:
            if entry["path"] != f"{folder_name}/{entry['id']}/SKILL.md":
                errors.append(f"Noncanonical bundle path: {entry['id']}")
                continue
            verify(entry["path"], entry["sha256"])
            folder = f"{folder_name}/{entry['id']}"
            try:
                content = local(entry["path"]).read_text()
                frontmatter = re.match(
                    r"^---\nname: (?P<name>[a-z0-9-]+)\ndescription: (?P<description>[^\n]+)\n"
                    r"version: (?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?)\n"
                    r"license: (?P<license>MIT|Apache-2\.0)\n---\n", content)
                if (not frontmatter or frontmatter["name"] != entry["id"] or
                        frontmatter["version"] != entry["version"] or
                        frontmatter["license"] != entry.get("license", "MIT") or
                        not frontmatter["description"].strip()):
                    errors.append(f"Invalid frontmatter: {entry['id']}")
                for sidecar in ["LICENSE.txt", "ADAPTATIONS.md"]:
                    if not local(f"{folder}/{sidecar}").read_text().strip():
                        errors.append(f"Empty sidecar: {folder}/{sidecar}")
                provenance = json.loads(local(f"{folder}/UPSTREAM.json").read_text())
                if section == "skills" and entry["kind"] == "adapted":
                    source_ids = entry["source_ids"]
                    if len(source_ids) != 1 or source_ids[0] not in sources:
                        errors.append(f"Missing source mapping: {entry['id']}")
                        continue
                    source = sources[source_ids[0]]
                    if provenance.get("repository") != source["repository"] or provenance.get("commit") != source["commit"] or provenance.get("license") != source["license"]:
                        errors.append(f"Provenance/source mismatch: {entry['id']}")
                    upstream = locked_files[source["id"]].get((provenance.get("path"), provenance.get("reference_path")))
                    if not upstream or provenance.get("sha256") != upstream["sha256"] or provenance.get("reference_path") != upstream["bundled_path"] or provenance.get("license_sha256") != upstream["license_sha256"]:
                        errors.append(f"Provenance/file mismatch: {entry['id']}")
                    if entry["license"] != source["license"]:
                        errors.append(f"Catalog license mismatch: {entry['id']}")
                if section == "skills" and entry["kind"] == "original" and entry["source_ids"]:
                    errors.append(f"Original module falsely claims upstream: {entry['id']}")
            except (OSError, ValueError, TypeError):
                errors.append(f"Invalid bundle sidecars: {entry['id']}")
            if section == "presets":
                selected = entry["skill_ids"] + entry["optional_skill_ids"]
                if not set(selected) <= skill_ids or len(selected) != len(set(selected)):
                    errors.append(f"Dangling or duplicate preset skill: {entry['id']}")
                if entry["optional"] is not True:
                    errors.append(f"Preset cannot be an automatic link default: {entry['id']}")
    return errors


if __name__ == "__main__":
    failures = validate(Path(__file__).resolve().parents[1])
    if failures:
        for failure in failures:
            print(f"ERROR: {failure}")
        raise SystemExit(1)
    print("skill registry: PASS (10 optional presets, pinned MIT/Apache-2.0 provenance, checksums, safe paths, metadata-only schemas)")
