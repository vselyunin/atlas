import type { ComponentProps } from 'react';
import { ChevronDown } from 'lucide-react';

export function Select(props: ComponentProps<'select'>) {
  return (
    <span className="field-select">
      <select {...props} />
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  );
}
