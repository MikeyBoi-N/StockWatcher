import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture
def fixture():
    def load(name):
        return json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    return load
