import logging


class _F(logging.Filter):
    def add_custom_value(self, v):
        pass

    def filter(self, r):
        return True


SENSITIVE_DATA_FILTER = _F()
