"""Disclosed finite admission contract shared by fixtures and hidden grader.

This is a restricted benchmark API, not a general Python security boundary.
Expected test values never belong in this module or the disclosed JSON.
"""

from __future__ import annotations

import ast
import hashlib
import json

IMPORT_MEMBERS = {
    "decimal": {"Decimal", "Context", "InvalidOperation", "DecimalException", "ROUND_HALF_UP", "ROUND_DOWN", "ROUND_UP", "ROUND_HALF_EVEN", "localcontext", "getcontext"},
    "math": {"isfinite", "isnan", "isinf", "floor", "ceil", "trunc", "copysign"},
    "re": {"compile", "match", "fullmatch", "search", "sub", "split", "escape", "IGNORECASE", "ASCII"},
}
BUILTIN_NAMES = {
    "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "float", "int", "isinstance", "len", "list", "map", "max", "min", "pow", "range", "repr", "reversed", "round", "set", "sorted", "str", "sum", "tuple", "zip", "TypeError", "ValueError", "OverflowError", "ArithmeticError", "Exception", "AttributeError",
}
MEMBER_NAMES = set().union(*IMPORT_MEMBERS.values()) | {
    "strip", "lstrip", "rstrip", "replace", "split", "startswith", "endswith", "isdigit", "isdecimal", "join", "casefold", "lower", "upper", "quantize", "to_integral_value", "to_integral_exact", "is_finite", "as_tuple", "adjusted", "copy_abs", "scaleb", "normalize", "digits", "exponent", "sign", "prec", "rounding", "Emin", "Emax", "create_decimal", "group", "groups", "groupdict", "get", "append", "extend", "count", "index",
}
FORBIDDEN_NAMES = {
    "eval", "exec", "compile", "globals", "locals", "vars", "getattr", "setattr", "delattr", "__import__", "open", "help", "breakpoint", "input", "print", "type", "object", "super", "memoryview", "classmethod", "staticmethod", "property",
}
CONTRACT = {
    "name": "pure-currency-function-v1",
    "imports": {module: sorted(members) for module, members in IMPORT_MEMBERS.items()},
    "builtins": sorted(BUILTIN_NAMES),
    "members": sorted(MEMBER_NAMES),
    "forbiddenNames": sorted(FORBIDDEN_NAMES),
    "nameBinding": "References must be admitted builtins or names declared by the candidate; all double-underscore names are rejected. Forbidden names also reject assignment and aliases.",
    "memberAccess": "Every attribute must be in members; direct imported-module access must also be in that module's imports list. Private attributes and arbitrary module traversal are not admitted.",
    "compileRule": "Use re.compile or import it under a non-forbidden alias; unqualified compile is forbidden even when imported.",
    "entryPoint": "Define exactly one top-level to_cents(value) function with one required positional parameter, no variadic or keyword-only parameters, and optional annotations.",
    "resourceScope": "Each test starts a new process with one input; this finite corpus does not prove purity for every Python program or enforce a memory-allocation limit.",
    "forbiddenSyntax": ["ClassDef", "Global", "Nonlocal", "AsyncFunctionDef", "Await", "Yield", "YieldFrom"],
    "description": "Self-contained pure currency conversion; no I/O, dynamic execution, runtime introspection, or module traversal outside admitted APIs. This finite admission policy is not a general Python security proof.",
}

CONTRACT_SHA256 = hashlib.sha256(
    json.dumps(CONTRACT, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
).hexdigest()


def validate_candidate(source: bytes) -> list[str]:
    """Fail closed on operations outside the disclosed pure-function contract."""
    try:
        tree = ast.parse(source)
    except (SyntaxError, ValueError, UnicodeError, RecursionError) as error:
        return [f"Invalid Python source: {type(error).__name__}"]
    nodes = list(ast.walk(tree))
    defined = {node.id for node in nodes if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)}
    defined.update(node.arg for node in nodes if isinstance(node, ast.arg))
    defined.update(node.name for node in nodes if isinstance(node, ast.FunctionDef))
    defined.update(node.name for node in nodes if isinstance(node, ast.ExceptHandler) and node.name)
    problems = []
    module_aliases = {}
    entries = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "to_cents"]
    if len(entries) != 1:
        problems.append("Define exactly one top-level to_cents(value) function")
    elif (entries[0].args.posonlyargs or len(entries[0].args.args) != 1
          or entries[0].args.args[0].arg != "value" or entries[0].args.defaults
          or entries[0].args.vararg or entries[0].args.kwarg or entries[0].args.kwonlyargs):
        problems.append("Entry point must accept exactly one required positional parameter named value")
    for node in nodes:
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in IMPORT_MEMBERS:
                    problems.append(f"Import outside contract: {alias.name}")
                defined.add(alias.asname or alias.name)
                module_aliases[alias.asname or alias.name] = alias.name
        elif isinstance(node, ast.ImportFrom):
            allowed = IMPORT_MEMBERS.get(node.module, set()) if node.level == 0 else set()
            for alias in node.names:
                if alias.name not in allowed:
                    problems.append(f"Imported member outside contract: {node.module}.{alias.name}")
                defined.add(alias.asname or alias.name)
    for name in defined:
        if name.startswith("__") or name in FORBIDDEN_NAMES:
            problems.append(f"Binding outside contract: {name}")
    for node in nodes:
        if type(node).__name__ in CONTRACT["forbiddenSyntax"]:
            problems.append(f"Syntax outside contract: {type(node).__name__}")
        if isinstance(node, ast.Attribute):
            if node.attr not in MEMBER_NAMES:
                problems.append(f"Member outside contract: {node.attr}")
            if isinstance(node.value, ast.Name) and node.value.id in module_aliases:
                module = module_aliases[node.value.id]
                if node.attr not in IMPORT_MEMBERS.get(module, set()):
                    problems.append(f"Module member outside contract: {module}.{node.attr}")
        if isinstance(node, ast.Name):
            # re.compile remains available as an admitted module member; an
            # unqualified compile alias is deliberately excluded.
            if node.id.startswith("__") or node.id in FORBIDDEN_NAMES:
                problems.append(f"Name outside contract: {node.id}")
            elif isinstance(node.ctx, ast.Load) and node.id not in defined | BUILTIN_NAMES:
                problems.append(f"Unbound name outside contract: {node.id}")
    return sorted(set(problems))
