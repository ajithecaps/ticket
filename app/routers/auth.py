from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select

from ..deps import CurrentUser, DbSession
from ..models import User
from ..schemas import PasswordChange, TokenOut, UserOut
from ..security import DUMMY_HASH, create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["Auth"])


@router.post("/login", response_model=TokenOut, summary="Log in (OAuth2 password form)")
def login(form: Annotated[OAuth2PasswordRequestForm, Depends()], db: DbSession):
    """`username` is the user's e-mail address. Works with the **Authorize** button in Swagger UI."""
    user = db.scalar(select(User).where(User.email == form.username.strip().lower()))
    valid = verify_password(form.password, user.hashed_password if user else DUMMY_HASH)
    if user is None or not valid:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Incorrect e-mail or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has been deactivated")
    return TokenOut(access_token=create_access_token(user.id), user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser):
    return user


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(payload: PasswordChange, user: CurrentUser, db: DbSession):
    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    user.hashed_password = hash_password(payload.new_password)
    db.commit()
