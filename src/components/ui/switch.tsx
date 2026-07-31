'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center border border-line transition-colors',
      'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-from',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-gradient-to-r data-[state=checked]:from-accent-from data-[state=checked]:to-accent-to',
      'data-[state=unchecked]:bg-white/[0.04]',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block h-3.5 w-3.5 bg-fg transition-transform',
        'data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-[2px]',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
