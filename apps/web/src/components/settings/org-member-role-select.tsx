import type { OrgRole } from "@atlas/core/contract";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ORG_ROLE_LABELS } from "@/lib/org-roles";

export function OrgMemberRoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: OrgRole;
  disabled?: boolean;
  onChange: (role: OrgRole) => void;
}) {
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next) {
          onChange(next as OrgRole);
        }
      }}
      value={value}
    >
      <SelectTrigger aria-label="Member role" size="sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(ORG_ROLE_LABELS) as OrgRole[]).map((role) => (
          <SelectItem key={role} value={role}>
            {ORG_ROLE_LABELS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
