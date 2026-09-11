import { Icon } from './Icon';

/** The confirmation pill that slides in at the bottom of the screen. */
export function Toast({ message }: { message: string }) {
  return (
    <div className="toast" role="status">
      <Icon name="check" size={16} strokeWidth={3} />
      {message}
    </div>
  );
}
