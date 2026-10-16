"""Planned windows of tickets, used by the timeline and the overlap check when assigning.

A ticket's window runs from its `start_date` (or, when that is not set, from when work started, was
assigned or the ticket was created) to its `due_date`. Tickets without a due date are "unscheduled"
and never count as overlapping.
"""
from __future__ import annotations

from datetime import datetime

from .models import Ticket
from .utils import ensure_utc


def window(t: Ticket) -> tuple[datetime, datetime] | None:
    if t.due_date is None:
        return None
    end = ensure_utc(t.due_date)
    start = ensure_utc(t.start_date or t.started_at or t.assigned_at or t.created_at)
    return (min(start, end), end)


def intersects(a: tuple[datetime, datetime], b: tuple[datetime, datetime]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def overlap_map(tickets: list[Ticket]) -> dict[int, list[str]]:
    """For each scheduled ticket id, the keys of the other tickets whose windows intersect it."""
    spans = [(t, w) for t in tickets if (w := window(t)) is not None]
    spans.sort(key=lambda x: x[1][0])
    out: dict[int, list[str]] = {t.id: [] for t, _ in spans}
    for i, (a, wa) in enumerate(spans):
        for b, wb in spans[i + 1:]:
            if wb[0] > wa[1]:
                break  # sorted by start: nothing later can intersect `a`
            if intersects(wa, wb):
                out[a.id].append(b.key)
                out[b.id].append(a.key)
    return out
