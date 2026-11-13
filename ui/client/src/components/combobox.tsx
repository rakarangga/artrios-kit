import * as React from "react"
import { CheckIcon, ChevronsUpDownIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export interface ComboOption {
  value: string
  label: string
  hint?: string
  prefix?: React.ReactNode
}

/** Dropdown with a search box: filters by label and hint, arrow keys move, Enter picks. */
export function Combobox({
  value,
  options,
  onChange,
  placeholder = "Select",
  searchPlaceholder = "Search",
  emptyText = "No match",
  className,
}: {
  value: string
  options: ComboOption[]
  onChange: (v: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const [active, setActive] = React.useState(0)
  const cur = options.find((o) => o.value === value)
  const list = React.useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(t)) : options
  }, [q, options])
  React.useEffect(() => setActive(0), [q, open])
  const pick = (v: string) => {
    onChange(v)
    setOpen(false)
    setQ("")
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQ("")
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn("min-w-44 justify-between gap-2 font-semibold", className)}>
          <span className="flex min-w-0 items-center gap-2">
            {cur?.prefix}
            <span className="truncate">{cur ? cur.label : placeholder}</span>
          </span>
          <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon className="size-4 shrink-0 opacity-50" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, list.length - 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              } else if (e.key === "Enter" && list[active]) {
                e.preventDefault()
                pick(list[active].value)
              }
            }}
          />
        </div>
        <ul role="listbox" className="max-h-64 overflow-y-auto p-1">
          {list.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</li>}
          {list.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                onClick={() => pick(o.value)}
                onMouseEnter={() => setActive(i)}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", i === active && "bg-accent text-accent-foreground")}
              >
                {o.prefix}
                <span className="font-semibold">{o.label}</span>
                {o.hint && <span className="truncate text-xs text-muted-foreground">{o.hint}</span>}
                {o.value === value && <CheckIcon className="ml-auto size-4" />}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
