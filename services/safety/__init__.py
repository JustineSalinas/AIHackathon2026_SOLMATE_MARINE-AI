"""Rule-based safety cutoffs. Deterministic, auditable, never ML.

See `services/safety/rules.py` for the rule set and the reasoning behind each
threshold, and `packages/contracts/safety.py` for the wire format.
"""

from services.safety.rules import IDLE_RPM_FLOOR, RULES, Rule, evaluate

__all__ = ["IDLE_RPM_FLOOR", "RULES", "Rule", "evaluate"]
