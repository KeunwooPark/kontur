def risky(n: int) -> None:
    if n < 0:
        raise Exception("negative")
    print(n)
