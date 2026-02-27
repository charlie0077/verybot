import { useState } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { Input } from "@/components/ui/input"

interface MaskedInputProps extends Omit<React.ComponentProps<"input">, "type"> {
  value: string
  onValueChange: (v: string) => void
}

export function MaskedInput({ value, onValueChange, ...props }: MaskedInputProps) {
  const [visible, setVisible] = useState(false)
  return (
    <div data-slot="masked-input" className="relative">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="pr-10"
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((p) => !p)}
        aria-label={visible ? "Hide value" : "Show value"}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {visible ? (
          <EyeOffIcon className="h-4 w-4" />
        ) : (
          <EyeIcon className="h-4 w-4" />
        )}
      </button>
    </div>
  )
}
