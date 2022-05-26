# This is a simple base58 library to encode & decode hex => base58
module Base58
  @chars = %w[
      1 2 3 4 5 6 7 8 9
    A B C D E F G H   J K L M N   P Q R S T U V W X Y Z
    a b c d e f g h i j k   m n o p q r s t u v w x y z
]
  @base = @chars.length

  def self.encode(hex)
    i = hex.to_i(16)
    buffer = String.new

    while i > 0
      remainder = i % @base
      i = i / @base
      buffer = @chars[remainder] + buffer
    end

    # add '1's to the start based on number of leading bytes of zeros
    leading_zero_bytes = (hex.match(/^([0]+)/) ? $1 : '').size / 2

    ("1"*leading_zero_bytes) + buffer
  end

  def self.decode(base58)
    total = 0 # integer to hold conversion to decimal

    # run through each character
    base58.reverse.each_char.with_index do |char, i|
      char_i = @chars.index(char) # get the index number for this character
      value  = (58**i) * char_i   # work out how many 58s this character represents
      total = total + value     # add to total
    end

    # convert this integer to hex
    hex = total.to_s(16)

    # add leading 00s for every leading 1
    leading_1s = (base58.match(/^([1]+)/) ? $1 : '').size

    ("00"*leading_1s) + hex
  end

end

# puts Base58.encode('0093ce48570b55c42c2af816aeaba06cfee1224faebb6127fe') #=> 1EUXSxuUVy2PC5enGXR1a3yxbEjNWMHuem
# puts Base58.decode('1EUXSxuUVy2PC5enGXR1a3yxbEjNWMHuem') #=> 0093ce48570b55c42c2af816aeaba06cfee1224faebb6127fe
