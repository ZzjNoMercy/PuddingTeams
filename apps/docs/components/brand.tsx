import Link from "next/link";
import Image from "next/image";

export function BrandLabel() {
  return (
    <span className="teams-brand">
      <Image src="/assets/puddingteams-avatar.png" width={30} height={30} alt="" />
      <span>PuddingTeams <i>Docs</i></span>
    </span>
  );
}

export function Brand() {
  return <Link href="/docs/" aria-label="PuddingTeams Documents"><BrandLabel /></Link>;
}
