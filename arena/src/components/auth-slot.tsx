import { Link } from "@tanstack/react-router";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export function AuthSlot() {
  const { user } = useCurrentUserState();
  if (user) {
    return (
      <div className="ml-1 max-w-[42vw] truncate sm:max-w-none">
        <UserButton />
      </div>
    );
  }
  return (
    <Link
      to="/login"
      className="ml-1 inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg"
    >
      Connect
    </Link>
  );
}
