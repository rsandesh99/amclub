/**
 * MOBILE_PARITY §2 — brand-styled select. RN has no <select>; the raw OS
 * picker can't be themed. This renders the web `.field-select` affordance
 * (consistent height, border, chevron) and opens a bottom-sheet option list.
 * No new native deps — plain Modal.
 */
import { useState } from 'react'
import { FlatList, Modal, Pressable, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useI18n } from '@/lib/i18n'
import { colors } from '@/lib/theme'

export interface SelectOption {
  value: string
  label: string
}

export function Select({
  value,
  options,
  onChange,
  placeholder,
  accessibilityLabel,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder: string
  /** Announced name for the control (the visible value doubles as label otherwise). */
  accessibilityLabel?: string
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? placeholder}
        className="h-11 flex-row items-center justify-between rounded-xl border border-border bg-surface px-3"
      >
        <Text className={`text-sm ${current ? 'text-foreground' : 'text-foreground-secondary'}`} numberOfLines={1}>
          {current?.label ?? placeholder}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.foregroundSecondary} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        {/* Backdrop tap dismisses. */}
        <Pressable className="flex-1 bg-black/40" onPress={() => setOpen(false)} accessibilityLabel={t('common.close')} />
        <View className="max-h-[60%] rounded-t-2xl bg-surface pb-6">
          <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
            <Text className="text-base font-semibold text-foreground">{placeholder}</Text>
            <TouchableOpacity onPress={() => setOpen(false)} accessibilityLabel={t('common.close')} className="p-1">
              <Ionicons name="close" size={20} color={colors.foreground} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={options}
            keyExtractor={(o) => o.value}
            renderItem={({ item }) => (
              <TouchableOpacity
                onPress={() => { onChange(item.value); setOpen(false) }}
                className={`flex-row items-center justify-between px-4 py-3 ${item.value === value ? 'bg-primary/5' : ''}`}
              >
                <Text className={`text-sm ${item.value === value ? 'font-semibold text-primary' : 'text-foreground'}`}>
                  {item.label}
                </Text>
                {item.value === value && <Ionicons name="checkmark" size={18} color={colors.primary} />}
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>
    </>
  )
}
