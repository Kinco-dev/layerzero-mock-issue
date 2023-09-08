require('dotenv').config()
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { before } from 'mocha'
import {
  ERC20,
  SimpleERC20,
  LZEndpointMock,
  ProxyOFT,
  OFT,
  OFTCore,
} from '../typechain-types'
import { BigNumberish } from 'ethers'
import chainIds from '../constants/chainIds'

describe('LayerZero bridging', () => {
  let lzEndpointMock_Ethereum: LZEndpointMock
  let lzEndpointMock_Polygon: LZEndpointMock

  let lzEndpointMock_Ethereum_address:string
  let lzEndpointMock_Polygon_address:string

  let ERC20_Ethereum: ERC20


  let proxyOFT_Ethereum: ProxyOFT
  let proxyOFT_Ethereum_address: string
  let proxyOFT_Ethereum_2: ProxyOFT
  let proxyOFT_Ethereum_address_2: string
  let OFT_Polygon: OFT
  let OFT_Polygon_address: string

  // signers
  let ownerSigner: SignerWithAddress
  let bobSigner: SignerWithAddress
  let aliceSigner: SignerWithAddress

  const tokenAmount = ethers.utils.parseEther('1')
  const tokenName = "Test"
  const tokenSymbol = "TEST"

  before(async () => {
    ;[ownerSigner, bobSigner, aliceSigner] = await ethers.getSigners()

    // Deploy LayerZero endpoints
    ;[
      lzEndpointMock_Ethereum,
      lzEndpointMock_Polygon,
    ] = (await Promise.all([
      ethers.deployContract('LZEndpointMock', [chainIds.ethereum]),
      ethers.deployContract('LZEndpointMock', [chainIds.polygon]),
    ])) as [unknown, unknown] as [
      LZEndpointMock,
      LZEndpointMock,
    ]
     [
      lzEndpointMock_Ethereum_address,
      lzEndpointMock_Polygon_address,
    ] = [
      lzEndpointMock_Ethereum.address,
      lzEndpointMock_Polygon.address,
    ]

    // Deploy the native ERC20 token on Ethereum
    ERC20_Ethereum = (await ethers.deployContract(
      'SimpleERC20'
    )) as unknown as ERC20

    // Deploy the ProxyOFT on Ethereum
    proxyOFT_Ethereum = (await ethers.deployContract('ProxyOFT', [
      lzEndpointMock_Ethereum_address,
      ERC20_Ethereum.address,
    ])) as unknown as ProxyOFT
    proxyOFT_Ethereum_address = proxyOFT_Ethereum.address

    // Deploy the ProxyOFT2 on Ethereum
    proxyOFT_Ethereum_2 = (await ethers.deployContract('ProxyOFT', [
      lzEndpointMock_Ethereum_address,
      ERC20_Ethereum.address,
    ])) as unknown as ProxyOFT
    proxyOFT_Ethereum_address_2 = proxyOFT_Ethereum_2.address

    // Deploy the destination LayerZero OFTs.
    ;[OFT_Polygon] =
      (await Promise.all([
        ethers.deployContract('OFT', [
          tokenName,
          tokenSymbol,
          lzEndpointMock_Polygon_address,
        ])

      ])) as [unknown] as [
        OFT
      ]
      OFT_Polygon_address = OFT_Polygon.address

    // Wire the lz endpoints to guide msgs back and forth
    await Promise.all([
      lzEndpointMock_Ethereum.setDestLzEndpoint(
        OFT_Polygon_address,
        lzEndpointMock_Polygon_address
      ),
      lzEndpointMock_Polygon.setDestLzEndpoint(
        proxyOFT_Ethereum_address,
        lzEndpointMock_Ethereum_address
      ),
    ])

    // Set each contracts source address so it can send to each other
    await Promise.all([
      proxyOFT_Ethereum.setTrustedRemote(
        chainIds.polygon,
        ethers.utils.solidityPack(
          ['address', 'address'],
          [OFT_Polygon_address, proxyOFT_Ethereum_address]
        )
      ),

      OFT_Polygon.setTrustedRemote(
        chainIds.ethereum,
        ethers.utils.solidityPack(
          ['address', 'address'],
          [proxyOFT_Ethereum_address, OFT_Polygon_address]
        )
      ),
    ])
  })

  async function sendFromHomeTo(destinationChainId: number) {
    // estimate nativeFees
    const { nativeFee } = await proxyOFT_Ethereum.estimateSendFee(
      destinationChainId,
      bobSigner.address,
      tokenAmount,
      false,
      '0x'
    )

    // swaps token to other chain
    await proxyOFT_Ethereum.connect(bobSigner).sendFrom(
      bobSigner.address,
      destinationChainId,
      bobSigner.address,
      tokenAmount,
      bobSigner.address,
      ethers.constants.AddressZero,
      '0x',
      { value: nativeFee }
    )
  }

  describe('Bridging tokens from home (Ethereum)', () => {
    it('Bridges to Polygon successfully ', async () => {
      // balances checks
      const proxyOFT_balance = await ERC20_Ethereum.balanceOf(
        proxyOFT_Ethereum_address
      )

      expect(proxyOFT_balance).equal(0)
      const OFT_Polygon_totalSupply = await OFT_Polygon.totalSupply()
      expect(OFT_Polygon_totalSupply).equal(0)

      // send tokens to an account
      await ERC20_Ethereum.transfer(bobSigner.address, tokenAmount)

      // approve the proxy to swap tokens
      await ERC20_Ethereum.connect(bobSigner).approve(
        proxyOFT_Ethereum_address,
        tokenAmount
      )

      // Bridge
      await sendFromHomeTo(chainIds.polygon)

      // tokens are now owned by the proxy contract, because this is the original oft chain
      expect(await ERC20_Ethereum.balanceOf(bobSigner.address)).equal(0)
      expect(await ERC20_Ethereum.balanceOf(proxyOFT_Ethereum_address)).equal(
        proxyOFT_balance.add(tokenAmount)
      )

      // tokens received on the dst chain
      expect(await OFT_Polygon.balanceOf(bobSigner.address)).equal(tokenAmount)
      expect(await OFT_Polygon.totalSupply()).equal(
        OFT_Polygon_totalSupply.add(tokenAmount)
      )
    })
  })

  describe('Bridging tokens to home', () => {
    async function sendFromChainToHome(OFT: OFTCore) {
      // estimate nativeFees
      const { nativeFee } = await OFT.estimateSendFee(
        chainIds.ethereum,
        bobSigner.address,
        tokenAmount,
        false,
        '0x'
      )

      // swaps token to other chain
      await OFT.connect(bobSigner).sendFrom(
        bobSigner.address,
        chainIds.ethereum,
        bobSigner.address,
        tokenAmount,
        bobSigner.address,
        ethers.constants.AddressZero,
        '0x',
        { value: nativeFee }
      )
    }
    before(async () => {
      await ERC20_Ethereum.transfer(bobSigner.address, tokenAmount)

      await Promise.all([
        ERC20_Ethereum.connect(bobSigner).approve(
          proxyOFT_Ethereum_address,
          tokenAmount
        ),
        sendFromHomeTo(chainIds.polygon),
      ])
    })
    it('Bridges from Polygon successfully', async () => {
      // Balances checks
      const ethereum_token_balance = await ERC20_Ethereum.balanceOf(
        bobSigner.address
      )
      const polygon_token_balance = await OFT_Polygon.balanceOf(
        bobSigner.address
      )

      expect(await OFT_Polygon.totalSupply()).equal(polygon_token_balance)

      // Bridge
      await sendFromChainToHome(OFT_Polygon)


      // tokens received on the destination chain
      expect(await ERC20_Ethereum.balanceOf(bobSigner.address)).equal(
        ethereum_token_balance.add(tokenAmount)
      )
    })
   
  })

  describe('Update UA on home (Ethereum)', () => {

    before(async () => {
      // send tokens to Bob
    await ERC20_Ethereum.transfer(bobSigner.address, tokenAmount)

    await lzEndpointMock_Polygon.setDestLzEndpoint(
      proxyOFT_Ethereum_address_2,
      lzEndpointMock_Ethereum_address
    ),
        // Update the trusted remotes between Polygon and Ethereum
    await proxyOFT_Ethereum_2.setTrustedRemote(
      chainIds.polygon,
      ethers.utils.solidityPack(
        ['address', 'address'],
        [OFT_Polygon_address, proxyOFT_Ethereum_address_2]
      )
    )
    await OFT_Polygon.setTrustedRemote(
      chainIds.ethereum,
      ethers.utils.solidityPack(
        ['address', 'address'],
        [proxyOFT_Ethereum_address_2, OFT_Polygon_address]
      )
    )
    })

  async function sendFromHomeTo2(destinationChainId: number) {
    // estimate nativeFees
    const { nativeFee } = await proxyOFT_Ethereum_2.estimateSendFee(
      destinationChainId,
      bobSigner.address,
      tokenAmount,
      false,
      '0x'
    )

    // swaps token to other chain
    await proxyOFT_Ethereum_2.connect(bobSigner).sendFrom(
      bobSigner.address,
      destinationChainId,
      bobSigner.address,
      tokenAmount,
      bobSigner.address,
      ethers.constants.AddressZero,
      '0x',
      { value: nativeFee }
    )
  }

  async function sendFromChainToHome2(OFT: OFTCore) {
    // estimate nativeFees
    const { nativeFee } = await OFT.estimateSendFee(
      chainIds.ethereum,
      bobSigner.address,
      tokenAmount,
      false,
      '0x'
    )

    // swaps token to other chain
    await OFT.connect(bobSigner).sendFrom(
      bobSigner.address,
      chainIds.ethereum,
      bobSigner.address,
      tokenAmount,
      bobSigner.address,
      ethers.constants.AddressZero,
      '0x',
      { value: nativeFee }
    )
  }
    it('Bridges to Polygon successfully', async () => {

      // send tokens to Bob
      await ERC20_Ethereum.transfer(bobSigner.address, tokenAmount)

      const bob_balance_ethereum = await ERC20_Ethereum.balanceOf(
        bobSigner.address
      )
      const bob_balance_polygon = await OFT_Polygon.balanceOf(
        bobSigner.address
      )

      // approve the proxy to swap tokens
      await ERC20_Ethereum.connect(bobSigner).approve(
        proxyOFT_Ethereum_address_2,
        tokenAmount
      )

      // Bridge
      await sendFromHomeTo2(chainIds.polygon)

      // tokens are now owned by the locker contract

      expect(await ERC20_Ethereum.balanceOf(bobSigner.address)).equal(bob_balance_ethereum.sub(tokenAmount))


      // tokens received on the dst chain
      expect(await OFT_Polygon.balanceOf(bobSigner.address)).equal(bob_balance_polygon.add(tokenAmount))

    })
    // HERE FAIL "LayerZeroMock: wrong nonce"
    it('Bridges from Polygon successfully', async () => {
      // Balances checks
      const bob_balance_ethereum = await ERC20_Ethereum.balanceOf(
        bobSigner.address
      )
      const bob_balance_polygon = await OFT_Polygon.balanceOf(
        bobSigner.address
      )

      // Bridge
      await sendFromChainToHome2(OFT_Polygon)

      // New balances
      expect(await ERC20_Ethereum.balanceOf(bobSigner.address)).equal(
        bob_balance_ethereum.add(tokenAmount)
      )

      expect(await OFT_Polygon.balanceOf(bobSigner.address)).equal(
        bob_balance_polygon.sub(tokenAmount)
      )

    })
  })
})
