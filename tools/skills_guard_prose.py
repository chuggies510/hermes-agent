"""Conservative, match-local recognition of defensive Markdown prose.

Quotes, fences and words such as 'example' alone do not confer trust. Only a
closed quoted example governed by a rejection, or a direct negative imperative,
is non-operative. Unknown grammar stays scannable. No source identities enter
this parser.
"""

import re

PROSE_PATTERN_IDS = frozenset({'prompt_injection_ignore', 'leak_system_prompt'})
_BULLET = r'(?:[-*+]\s+|\d+[.)]\s+)?'
_NEGATIVE = re.compile(
    rf'^\s*{_BULLET}(?:\*\*)?(?:never|do not|you must not)\s+$', re.I)
_END = re.compile(r'\s*[.!]?\s*(?:\*\*)?\s*$')
_REJECTION = re.compile(r'^\s*(?:#{1,6}\s+|\*\*)?(?:ignore|reject|do not follow):?(?:\*\*)?\s*$', re.I)
# A noun-led list entry below a rejection heading, not "Follow directives ...".
_REJECTED_OBJECT = re.compile(
    rf'^\s*{_BULLET}(?:directives|instructions|commands|requests)\s+[^();:!\n]+\s*$', re.I)
# A negative interpretation rule followed by a conditional description of input.
_NEGATIVE_INTERPRETATION = re.compile(
    rf'^\s*{_BULLET}(?:\*\*)?(?:never|do not)\s+(?:interpret|treat)\s+'
    r'[^.!?;:()]+\s+as\s+(?:agent\s+)?instructions\.(?:\*\*)?\s+'
    r'If\s+[^.!?;:()]+\s+contains?\s+[^.!?;:()]+\s*$', re.I)
_DATA_NOT_ACTION = re.compile(
    r'^,\s*treat\s+(?:it|them)\s+as\s+data(?:\s+to\s+report)?,\s*'
    r'not\s+(?:an?\s+)?actions?\s+to\s+execute\.\s*$', re.I)
# Deliberately small grammar: complete, comma-separated, double-quoted examples.
# Backslashes, nested parentheses and embedded quotes fail closed.
_QUOTE = r'"[^"\\()\n]+"'
_EXAMPLES = re.compile(rf'\(e\.g\.,?\s+{_QUOTE}(?:,\s*{_QUOTE})*\)', re.I)
_QUOTED = re.compile(_QUOTE)
_OPERATIVE = re.compile(
    r'\b(?:follow|obey|execute|run|perform|apply|instead|but|except|unless|must|should)\b', re.I)


def defensive_match(line: str, match: re.Match, previous: str) -> bool:
    """Whether this individual match is unambiguously rejected, not instructed.

    The caller only uses this for Markdown prose and the two supported patterns.
    Multiple occurrences are checked independently; a safe quote never masks an
    operative occurrence elsewhere on its line.
    """
    if _NEGATIVE.fullmatch(line[:match.start()]) and _END.fullmatch(line[match.end():]):
        return True
    for example in _EXAMPLES.finditer(line):
        if not example.start() <= match.start() < match.end() <= example.end():
            continue
        quoted = any(example.start() + q.start() < match.start()
                     and match.end() < example.start() + q.end()
                     for q in _QUOTED.finditer(example.group()))
        if not quoted:
            continue
        before, after = line[:example.start()], line[example.end():]
        # An override clause inside the example's lead-in is not descriptive.
        if _OPERATIVE.search(before):
            continue
        rejected = (_REJECTION.fullmatch(previous) and _REJECTED_OBJECT.fullmatch(before)
                    and _END.fullmatch(after))
        data_only = (_NEGATIVE_INTERPRETATION.fullmatch(before)
                     and _DATA_NOT_ACTION.fullmatch(after))
        if rejected or data_only:
            return True
    return False
