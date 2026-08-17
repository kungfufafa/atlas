import {
  validateSetupEmail,
  validateSetupName,
  validateSetupPassword,
  validateSetupPhone,
} from "@atlas/core/setup-validation";
import { Upload04Icon } from "hugeicons-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SetupStepBackupImport } from "@/components/setup-wizard/SetupStepBackupImport";
import {
  readSetupAccountPrefill,
  type SetupAccountDraft,
  writeSetupAccountPrefill,
} from "@/components/setup-wizard/setup-wizard.shared";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";

interface SetupStepAccountProps {
  onNext: (account: SetupAccountDraft) => void;
}

type SetupAccountMode = "account" | "backup";

export function SetupStepAccount({ onNext }: SetupStepAccountProps) {
  const navigate = useNavigate();
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<SetupAccountMode>("account");
  const [initialBackupFile, setInitialBackupFile] = useState<File | null>(null);
  const prefill = readSetupAccountPrefill();
  const [name, setName] = useState(prefill?.name ?? "");
  const [email, setEmail] = useState(prefill?.email ?? "");
  const [phone, setPhone] = useState(prefill?.phone ?? "");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (mode === "backup") {
    return (
      <SetupStepBackupImport
        initialFile={initialBackupFile}
        onBack={() => {
          setInitialBackupFile(null);
          setMode("account");
        }}
        onRestored={() => navigate("/login", { replace: true })}
      />
    );
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const nextAccount: SetupAccountDraft = {
      email: email.trim(),
      name: name.trim(),
      password,
      phone: phone.trim(),
    };
    const validationError =
      validateSetupName(nextAccount.name) ??
      validateSetupEmail(nextAccount.email) ??
      validateSetupPhone(nextAccount.phone) ??
      validateSetupPassword(password, confirmPassword);

    if (validationError) {
      setError(validationError);
      return;
    }

    writeSetupAccountPrefill(nextAccount);
    onNext(nextAccount);
  };

  return (
    <Card className="p-6">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div>
          <label
            className="mb-1 block font-medium text-sm"
            htmlFor="setup-name"
          >
            Your name
          </label>
          <Input
            id="setup-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="Jane Admin"
            required
            value={name}
          />
        </div>
        <div>
          <label
            className="mb-1 block font-medium text-sm"
            htmlFor="setup-email"
          >
            Email
          </label>
          <Input
            id="setup-email"
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
            required
            type="email"
            value={email}
          />
        </div>
        <div>
          <label
            className="mb-1 block font-medium text-sm"
            htmlFor="setup-phone"
          >
            Phone{" "}
            <span className="font-normal text-muted-foreground">
              (optional)
            </span>
          </label>
          <Input
            id="setup-phone"
            onChange={(event) => setPhone(event.target.value)}
            placeholder="+628123456789"
            type="tel"
            value={phone}
          />
        </div>
        <div>
          <label
            className="mb-1 block font-medium text-sm"
            htmlFor="setup-password"
          >
            Password
          </label>
          <PasswordInput
            id="setup-password"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            required
            value={password}
          />
        </div>
        <div>
          <label
            className="mb-1 block font-medium text-sm"
            htmlFor="setup-confirm"
          >
            Confirm Password
          </label>
          <PasswordInput
            id="setup-confirm"
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="••••••••"
            required
            value={confirmPassword}
          />
        </div>
        {error && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-red-800 text-sm dark:bg-red-950/30 dark:text-red-200">
            {error}
          </div>
        )}
        <Button className="w-full" size="lg" type="submit">
          Continue
        </Button>
        <div className="flex justify-center border-border border-t pt-4">
          <input
            accept=".zip,application/zip"
            aria-label="Choose a backup file"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              if (!file) {
                return;
              }
              setInitialBackupFile(file);
              setMode("backup");
            }}
            ref={backupInputRef}
            type="file"
          />
          <Button
            onClick={() => backupInputRef.current?.click()}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Upload04Icon aria-hidden className="size-3.5" />I have a backup
          </Button>
        </div>
      </form>
    </Card>
  );
}
