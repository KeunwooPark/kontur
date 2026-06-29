def increment(x: int) -> int:
    return (x + 1)


def add_two(x: int) -> int:
    once = increment(x)
    twice = increment(once)
    return twice
