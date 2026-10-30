import { Avatar, type AvatarSize } from "@/components/ui/Avatar";
import type { NeuronDTO } from "@/server/connectome/types";

/**
 * A neuron's identity row: avatar (pfp for claimed / platform-attributed brains, else monogram), public title, and the
 * codename underneath when the title is a public name. `regionColor` adds a small region dot on the avatar.
 * No client hooks: renders in server components (Wiring) and client ones alike.
 */
export function NeuronName({
  neuron,
  size = 24,
  regionColor,
  codename = true,
  className = "",
}: {
  neuron: Pick<NeuronDTO, "label" | "codename" | "avatarUrl" | "tier">;
  size?: AvatarSize;
  regionColor?: string;
  /** Show the codename as secondary text when it differs from the title. */
  codename?: boolean;
  className?: string;
}) {
  const secondary = codename && neuron.label !== neuron.codename ? neuron.codename : null;
  return (
    <span className={`flex min-w-0 items-center gap-2 ${className}`}>
      <span className="relative inline-flex shrink-0">
        <Avatar src={neuron.avatarUrl} name={neuron.label} tier={neuron.tier} size={size} />
        {regionColor && (
          <span
            className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-panel"
            style={{ background: regionColor }}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate">{neuron.label}</span>
        {secondary && <span className="num block truncate text-[10px] font-normal text-mute">{secondary}</span>}
      </span>
    </span>
  );
}
