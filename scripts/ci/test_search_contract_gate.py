"""Protect the mandatory Search CI boundary, including its skip rejection."""
import copy
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]


def validate(workflow):
    jobs = workflow['jobs']
    search = jobs['search-web-contracts']
    if 'if' in search or search.get('needs'):
        raise ValueError('Search must run independently on every PR')
    verifiers = [step for step in search['steps'] if step.get('run', '').strip() == 'npm run verify:search-contracts']
    if not verifiers or any('if' in step or step.get('continue-on-error') for step in verifiers):
        raise ValueError('Search verifier missing')
    gate = jobs['ci-status']
    if 'search-web-contracts' not in gate['needs']:
        raise ValueError('Search not required by aggregate gate')
    script = '\n'.join(step.get('run', '') for step in gate['steps'])
    if 'needs[\'search-web-contracts\'].result }}" != "success"' not in script:
        raise ValueError('Search skips must fail the aggregate gate')


class SearchGateTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())

    def test_required_search_runs(self):
        validate(self.workflow)

    def test_path_filter_or_dependency_cannot_skip_search(self):
        for key, value in [('if', 'false'), ('needs', ['paths'])]:
            broken = copy.deepcopy(self.workflow)
            broken['jobs']['search-web-contracts'][key] = value
            with self.assertRaises(ValueError):
                validate(broken)

    def test_removed_requirement_and_skip_rejection_fail(self):
        broken = copy.deepcopy(self.workflow)
        broken['jobs']['ci-status']['needs'].remove('search-web-contracts')
        with self.assertRaises(ValueError):
            validate(broken)
        broken = copy.deepcopy(self.workflow)
        for step in broken['jobs']['ci-status']['steps']:
            if 'run' in step:
                step['run'] = step['run'].replace('needs[\'search-web-contracts\'].result', 'needs.other.result')
        with self.assertRaises(ValueError):
            validate(broken)


if __name__ == '__main__':
    unittest.main()
