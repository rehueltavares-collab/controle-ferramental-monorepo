from passlib.context import CryptContext

# Compatível no Windows, sem dependência do bcrypt.
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

def hash_pin(pin: str) -> str:
    return pwd_context.hash(pin)

def verify_pin(pin: str, pin_hash: str) -> bool:
    if not pin_hash:
        return False
    return pwd_context.verify(pin, pin_hash)
