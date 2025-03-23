import { useContext, useEffect, useState } from 'react'
import * as yup from 'yup'
import {
  ProgramAccount,
  Governance,
  serializeInstructionToBase64,
} from '@solana/spl-governance'
import { validateInstruction } from '@utils/instructionTools'
import { UiInstruction } from '@utils/uiTypes/proposalCreationTypes'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { NewProposalContext } from '../../../new'
import InstructionForm, { InstructionInput } from '../FormCreator'
import { InstructionInputType } from '../inputInstructionType'
import { AssetAccount } from '@utils/uiTypes/assets'
import useWalletOnePointOh from '@hooks/useWalletOnePointOh'
import { useRealmQuery } from '@hooks/queries/realm'
import useGovernanceAssets from '@hooks/useGovernanceAssets'
import {
  setWhirlpoolsConfig,
  fetchSplashPool,
  fetchConcentratedLiquidityPool,
} from '@orca-so/whirlpools'

interface QueryPoolStatsForm {
  governedAccount?: AssetAccount
  tokenAMint: string
  tokenBMint: string
  isConcentrated?: boolean
  tickSpacing?: number
}

export default function QueryPoolStats({
  index,
  governance,
}: {
  index: number
  governance: ProgramAccount<Governance> | null
}) {
  const { handleSetInstructions } = useContext(NewProposalContext)
  const realm = useRealmQuery().data?.result
  const { assetAccounts } = useGovernanceAssets()
  const wallet = useWalletOnePointOh()

  const [form, setForm] = useState<QueryPoolStatsForm>({
    tokenAMint: '',
    tokenBMint: '',
    isConcentrated: false,
    tickSpacing: 64,
  })
  const [formErrors, setFormErrors] = useState({})
  const [poolInfo, setPoolInfo] = useState<any>(null)

  const shouldBeGoverned = !!(index !== 0 && governance)

  const schema = yup.object().shape({
    governedAccount: yup.object().nullable().required('Governance account is required'),
    tokenAMint: yup.string().required('Token A mint required'),
    tokenBMint: yup.string().required('Token B mint required'),
  })

  // Realms expects an on-chain instruction, but “querying” is off-chain.
  // We can return a "no-op" instruction or just empty.
  async function getInstruction(): Promise<UiInstruction> {
    const isValid = await validateInstruction({ schema, form, setFormErrors })
    let serializedInstruction = ''
    let instructions: TransactionInstruction[] = []

    if (isValid && form.governedAccount?.governance?.account && wallet?.publicKey) {
      await setWhirlpoolsConfig('solanaDevnet')
      const mintA = new PublicKey(form.tokenAMint)
      const mintB = new PublicKey(form.tokenBMint)

      let info
      if (!form.isConcentrated) {
        info = await fetchSplashPool(undefined, mintA, mintB)
      } else {
        info = await fetchConcentratedLiquidityPool(
          undefined,
          mintA,
          mintB,
          form.tickSpacing ?? 64
        )
      }
      setPoolInfo(info)
      // If you want an actual no-op instruction, do something like:
      instructions = [
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey('11111111111111111111111111111111'), // System Program
          data: Buffer.alloc(0),
        }),
      ]
      if (instructions.length > 0) {
        serializedInstruction = serializeInstructionToBase64(instructions[0])
      }
    }

    return {
      serializedInstruction,
      isValid,
      governance: form?.governedAccount?.governance,
    }
  }

  const inputs: InstructionInput[] = [
    {
      label: 'Governance',
      initialValue: null,
      name: 'governedAccount',
      type: InstructionInputType.GOVERNED_ACCOUNT,
      shouldBeGoverned,
      governance,
      options: assetAccounts,
    },
    {
      label: 'Token A Mint',
      initialValue: '',
      name: 'tokenAMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Token B Mint',
      initialValue: '',
      name: 'tokenBMint',
      type: InstructionInputType.INPUT,
      inputType: 'text',
    },
    {
      label: 'Is Concentrated?',
      initialValue: false,
      name: 'isConcentrated',
      type: InstructionInputType.SWITCH,
    },
    {
      label: 'Tick Spacing (if Concentrated)',
      initialValue: 64,
      name: 'tickSpacing',
      type: InstructionInputType.INPUT,
      inputType: 'number',
    },
  ]

  useEffect(() => {
    handleSetInstructions(
      {
        governedAccount: form?.governedAccount?.governance,
        getInstruction,
      },
      index
    )
  }, [form])

  return (
    <div>
      <InstructionForm
        outerForm={form}
        setForm={setForm}
        inputs={inputs}
        setFormErrors={setFormErrors}
        formErrors={formErrors}
      />
      {poolInfo && (
        <pre className="mt-4 p-2 border border-fgd-4 rounded bg-bkg-1">
          {JSON.stringify(poolInfo, null, 2)}
        </pre>
      )}
    </div>
  )
}
