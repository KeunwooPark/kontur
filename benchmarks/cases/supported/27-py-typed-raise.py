def risky(n: int) -> None:
    if n < 0:
        raise TypeError("negative")
    print(n)
