import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, BlockType, ExperienceStep, getBlockTypeLabel } from '../models/types';
import { PushDownButton, InsetTextField } from '../components/PushDownButton';
import { oklchShadow, withAlpha } from '../utils/colorUtils';
import { ON_SURFACE, BORDER, PRIMARY } from '../utils/constants';
import {
  ArrowLeft, Play, Plus, X, Disc3, LayoutList, Compass,
  AlertTriangle, GitBranch, CheckCircle2, Circle,
} from 'lucide-react';
import DraggableSheet from '../components/DraggableSheet';

function iconForType(type: BlockType) {
  switch (type) {
    case 'roulette': return Disc3;
    case 'listRandomizer': return LayoutList;
    case 'experience': return Compass;
  }
}

function colorForType(type: BlockType) {
  switch (type) {
    case 'roulette': return '#38BDF8';
    case 'listRandomizer': return '#88d515';
    case 'experience': return '#c827d4';
  }
}

interface ExperienceBuilderScreenProps {
  block: Block;
  allBlocks: Block[];
  onBlockUpdated?: (block: Block) => void;
}

export default function ExperienceBuilderScreen({ block, allBlocks, onBlockUpdated }: ExperienceBuilderScreenProps) {
  const navigate = useNavigate();
  const [currentBlock, setCurrentBlock] = useState(block);
  const [showAddSheet, setShowAddSheet] = useState(false);
  const [showConditionSheet, setShowConditionSheet] = useState<number | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const steps = currentBlock.experienceConfig?.steps ?? [];
  const pickableBlocks = allBlocks.filter(b => b.type === 'roulette' || b.type === 'listRandomizer');

  const autoSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onBlockUpdated?.(currentBlock);
    }, 400);
  }, [currentBlock, onBlockUpdated]);

  const findBlock = (id: string) => allBlocks.find(b => b.id === id);

  const addStep = (pickedBlock: Block) => {
    const newBlock = { ...currentBlock };
    newBlock.experienceConfig = {
      ...newBlock.experienceConfig!,
      steps: [...steps, { blockId: pickedBlock.id }],
    };
    setCurrentBlock(newBlock);
    autoSave();
  };

  const removeStep = (index: number) => {
    const newBlock = { ...currentBlock };
    newBlock.experienceConfig = {
      ...newBlock.experienceConfig!,
      steps: steps.filter((_, i) => i !== index),
    };
    setCurrentBlock(newBlock);
    autoSave();
  };

  const setStepCondition = (index: number, conditionSegment: string | null) => {
    const newBlock = { ...currentBlock };
    const newSteps = [...steps];
    newSteps[index] = { ...newSteps[index], conditionSegment };
    newBlock.experienceConfig = { ...newBlock.experienceConfig!, steps: newSteps };
    setCurrentBlock(newBlock);
    autoSave();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', backgroundColor: '#FFF' }}>
      {/* App bar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 8px 0', gap: 4 }}>
        <button onClick={() => navigate(-1)} style={{ padding: 8 }}>
          <ArrowLeft size={24} color={ON_SURFACE} />
        </button>
        <div style={{ flex: 1 }}>
          <InsetTextField
            value={currentBlock.name}
            onChange={v => {
              setCurrentBlock({ ...currentBlock, name: v });
              autoSave();
            }}
            placeholder="Experience name"
            inputStyle={{ fontWeight: 700, fontSize: 18 }}
          />
        </div>
        <button
          onClick={() => { /* Preview coming soon */ }}
          style={{ padding: 8, opacity: steps.length > 0 ? 1 : 0.3 }}
          disabled={steps.length === 0}
        >
          <Play size={24} color={PRIMARY} />
        </button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        {steps.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', padding: '0 40px', textAlign: 'center',
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: 22,
              backgroundColor: withAlpha(PRIMARY, 0.12),
              display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20,
            }}>
              <Compass size={36} color={PRIMARY} />
            </div>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: ON_SURFACE, margin: '0 0 8px' }}>Add your first step</h3>
            <p style={{ fontSize: 14, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.5), margin: 0 }}>
              Chain roulettes and lists into a guided experience.
            </p>
          </div>
        ) : (
          <>
            {/* Description */}
            <textarea
              value={currentBlock.experienceConfig?.description ?? ''}
              onChange={e => {
                const newBlock = { ...currentBlock };
                newBlock.experienceConfig = {
                  ...newBlock.experienceConfig!,
                  description: e.target.value || null,
                };
                setCurrentBlock(newBlock);
                autoSave();
              }}
              placeholder="Describe this experience (optional)"
              rows={2}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 16,
                border: '1.5px solid #E4E4E7', backgroundColor: '#F4F4F5',
                fontWeight: 500, fontSize: 14, fontFamily: 'inherit',
                outline: 'none', resize: 'none', marginBottom: 20,
              }}
            />

            {/* Steps */}
            {steps.map((step, index) => {
              const refBlock = findBlock(step.blockId);
              return (
                <div key={index}>
                  {/* Connector */}
                  {index > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', padding: '2px 0', gap: 12 }}>
                      <div style={{ width: 32 }} />
                      <div style={{ width: 2, height: 36, backgroundColor: BORDER }} />
                      <div
                        onClick={() => setShowConditionSheet(index)}
                        style={{
                          padding: '4px 10px', borderRadius: 10, cursor: 'pointer',
                          backgroundColor: step.conditionSegment ? withAlpha(PRIMARY, 0.1) : '#F4F4F5',
                          border: `1.5px solid ${step.conditionSegment ? withAlpha(PRIMARY, 0.3) : '#E4E4E7'}`,
                          display: 'flex', alignItems: 'center', gap: 5,
                          fontSize: 12, fontWeight: 600,
                          color: step.conditionSegment ? PRIMARY : withAlpha(ON_SURFACE, 0.5),
                        }}
                      >
                        <GitBranch size={13} />
                        {step.conditionSegment ? `If result = ${step.conditionSegment}` : 'Always'}
                      </div>
                    </div>
                  )}

                  {/* Step card */}
                  {refBlock ? (
                    <StepCard3D
                      index={index}
                      block={refBlock}
                      onDelete={() => removeStep(index)}
                    />
                  ) : (
                    <MissingCard index={index} onDelete={() => removeStep(index)} />
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>

      {/* Bottom bar */}
      <div style={{ padding: '8px 20px 16px' }}>
        <PushDownButton color={ON_SURFACE} onTap={() => {
          if (pickableBlocks.length === 0) return;
          setShowAddSheet(true);
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: '#FFF' }}>
            <Plus size={22} />
            <span style={{ fontSize: 17, fontWeight: 800, letterSpacing: 0.5 }}>Add Step</span>
          </div>
        </PushDownButton>
      </div>

      {/* Add step sheet */}
      {showAddSheet && (
        <DraggableSheet onClose={() => setShowAddSheet(false)}>
          <div style={{ padding: '0 24px 32px' }}>
            <h3 style={{ fontSize: 20, fontWeight: 800, color: ON_SURFACE, margin: '0 0 6px' }}>Add a Step</h3>
            <p style={{ fontSize: 14, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.5), margin: '0 0 18px' }}>
              Pick a block to add to this experience.
            </p>
            {pickableBlocks.map(b => {
              const tc = colorForType(b.type);
              const TypeIcon = iconForType(b.type);
              return (
                <div
                  key={b.id}
                  onClick={() => { setShowAddSheet(false); addStep(b); }}
                  style={{
                    display: 'flex', alignItems: 'center', padding: '14px 16px',
                    borderRadius: 18, border: `1px solid ${BORDER}`,
                    marginBottom: 10, cursor: 'pointer',
                  }}
                >
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%',
                    backgroundColor: withAlpha(tc, 0.15),
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <TypeIcon size={22} color={tc} />
                  </div>
                  <div style={{ flex: 1, marginLeft: 14 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: ON_SURFACE }}>{b.name}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: tc }}>{getBlockTypeLabel(b.type)}</div>
                  </div>
                  <Plus size={20} color={withAlpha(ON_SURFACE, 0.35)} />
                </div>
              );
            })}
          </div>
        </DraggableSheet>
      )}

      {/* Condition sheet */}
      {showConditionSheet !== null && (() => {
        const stepIndex = showConditionSheet;
        const step = steps[stepIndex];
        const prevBlock = stepIndex > 0 ? findBlock(steps[stepIndex - 1].blockId) : null;
        const segments: string[] = [];
        if (prevBlock?.type === 'roulette' && prevBlock.wheelConfig) {
          for (const item of prevBlock.wheelConfig.items) {
            if (item.text && !segments.includes(item.text)) segments.push(item.text);
          }
        }

        return (
          <DraggableSheet onClose={() => setShowConditionSheet(null)}>
            <div style={{ padding: '0 24px 32px' }}>
              <h3 style={{ fontSize: 20, fontWeight: 800, color: ON_SURFACE, margin: '0 0 6px' }}>Step Condition</h3>
              <p style={{ fontSize: 14, fontWeight: 500, color: withAlpha(ON_SURFACE, 0.5), margin: '0 0 18px' }}>
                {segments.length === 0 ? 'No conditions available for this step.' : 'Choose when this step should run.'}
              </p>

              <ConditionOption
                label="Always"
                isSelected={!step.conditionSegment}
                onTap={() => { setStepCondition(stepIndex, null); setShowConditionSheet(null); }}
              />
              {segments.map(seg => (
                <div key={seg} style={{ marginTop: 8 }}>
                  <ConditionOption
                    label={`If result = ${seg}`}
                    isSelected={step.conditionSegment === seg}
                    onTap={() => { setStepCondition(stepIndex, seg); setShowConditionSheet(null); }}
                  />
                </div>
              ))}
            </div>
          </DraggableSheet>
        );
      })()}
    </div>
  );
}

function ConditionOption({ label, isSelected, onTap }: { label: string; isSelected: boolean; onTap: () => void }) {
  return (
    <div
      onClick={onTap}
      style={{
        display: 'flex', alignItems: 'center', padding: '14px 16px',
        borderRadius: 14, cursor: 'pointer', transition: 'all 0.18s',
        backgroundColor: isSelected ? withAlpha(PRIMARY, 0.12) : '#F4F4F5',
        border: `1.5px solid ${isSelected ? PRIMARY : '#E4E4E7'}`,
      }}
    >
      {isSelected ? <CheckCircle2 size={20} color={PRIMARY} /> : <Circle size={20} color={withAlpha(ON_SURFACE, 0.3)} />}
      <span style={{
        marginLeft: 12, fontWeight: 600, fontSize: 15,
        color: isSelected ? ON_SURFACE : withAlpha(ON_SURFACE, 0.6),
      }}>
        {label}
      </span>
    </div>
  );
}

function StepCard3D({ index, block, onDelete }: { index: number; block: Block; onDelete: () => void }) {
  const typeColor = colorForType(block.type);
  const bottomColor = oklchShadow(typeColor);
  const innerStroke = oklchShadow(typeColor, 0.06);
  const TypeIcon = iconForType(block.type);

  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 6.5, bottom: 0,
        borderRadius: 21, backgroundColor: bottomColor,
        border: `2.5px solid ${oklchShadow(typeColor, 0.16)}`,
      }} />
      <div style={{
        position: 'relative', marginBottom: 6.5, borderRadius: 21,
        backgroundColor: typeColor, border: `2.5px solid ${innerStroke}`,
        padding: '16px 18px', display: 'flex', alignItems: 'center',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          backgroundColor: 'rgba(255,255,255,0.25)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 800, color: '#FFF',
        }}>
          {index + 1}
        </div>
        <div style={{ width: 14 }} />
        <TypeIcon size={22} color="rgba(255,255,255,0.8)" />
        <div style={{ width: 10 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#FFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {block.name}
          </div>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>
            {getBlockTypeLabel(block.type)}
          </div>
        </div>
        <div
          onClick={onDelete}
          style={{
            width: 32, height: 32, borderRadius: 10,
            backgroundColor: 'rgba(255,255,255,0.2)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <X size={18} color="rgba(255,255,255,0.9)" />
        </div>
      </div>
    </div>
  );
}

function MissingCard({ index, onDelete }: { index: number; onDelete: () => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <div style={{
        position: 'absolute', left: 0, right: 0, top: 6.5, bottom: 0,
        borderRadius: 21, backgroundColor: oklchShadow('#F4F4F5'),
      }} />
      <div style={{
        position: 'relative', marginBottom: 6.5, borderRadius: 21,
        backgroundColor: '#F4F4F5',
        border: `2.5px solid ${oklchShadow('#F4F4F5', 0.06)}`,
        padding: '16px 18px', display: 'flex', alignItems: 'center',
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          backgroundColor: withAlpha(ON_SURFACE, 0.08),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 800, color: withAlpha(ON_SURFACE, 0.4),
        }}>
          {index + 1}
        </div>
        <div style={{ width: 14 }} />
        <AlertTriangle size={20} color={withAlpha(ON_SURFACE, 0.35)} />
        <div style={{ width: 10 }} />
        <div style={{ flex: 1, fontSize: 15, fontWeight: 600, color: withAlpha(ON_SURFACE, 0.4) }}>Missing block</div>
        <div
          onClick={onDelete}
          style={{
            width: 32, height: 32, borderRadius: 10,
            backgroundColor: '#FEE2E2',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <X size={16} color="#EF4444" />
        </div>
      </div>
    </div>
  );
}
