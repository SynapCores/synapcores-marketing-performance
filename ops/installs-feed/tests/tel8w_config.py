"""Build the export job's config (internal / partner lists) from a tel8w.py module.

The lists themselves are private (they name our own networks and installs), so they are never committed:
this helper reads them from the installs-sprint tel8w.py at test / install time.

  python3 -I tests/tel8w_config.py /path/to/tel8w.py > installs-feed.json
"""
import importlib.util
import json
import sys


def load_tel8w(path):
    spec = importlib.util.spec_from_file_location("tel8w_ref", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def config_from_tel8w(mod):
    lo, hi = mod.NIGHTLY_CI_UTC
    return {
        "about": "Installs feed classification lists, generated from tel8w.py. Private: install root-only.",
        "internal_ip": sorted(mod.INTERNAL_IP),
        "internal_24": sorted(mod.INTERNAL_24),
        "likely_internal_24": sorted(mod.LIKELY_INTERNAL_24),
        "internal_iid": sorted(mod.INTERNAL_IID),
        "likely_internal_iid": sorted(mod.LIKELY_INTERNAL_IID),
        "test_iid": sorted(mod.TEST_IID),
        "partner_24": sorted(mod.PARTNER_24),
        "ci_extra_24": sorted(mod.CI_EXTRA_24),
        "person_merge": [list(p) for p in mod.PERSON_MERGE],
        "nightly_ci_utc": [lo.strftime("%H:%M"), hi.strftime("%H:%M")],
    }


if __name__ == "__main__":
    json.dump(config_from_tel8w(load_tel8w(sys.argv[1])), sys.stdout, indent=1)
    sys.stdout.write("\n")
