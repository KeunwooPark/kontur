class Counter:
    count: int

    def increment(self) -> None:
        self.count = (self.count + 1)

    def current(self) -> int:
        return self.count
