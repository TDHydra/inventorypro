import StockQuickAdd from '../../../src/components/quickadd/StockQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddStockScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Stock">
      {onSaved => <StockQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
